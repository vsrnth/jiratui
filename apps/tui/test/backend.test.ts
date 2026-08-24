import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { IssueCache, scopePartitionSiteId, teamPartitionSiteId } from "../src/storage/cache";
import { JiraDeskBackend, TeamWorkspace, Workspace } from "../src/backend";
import { SystemCredentialStore, type CredentialResult, type SavedCredentials, type SecretProvider } from "../src/storage/credentials";
import type { IssueDetail, IssueSummary } from "../src/domain";
import type { JiraTeamReadPort } from "../src/backend/ports";
import { emptyUpdateLedger, markGroupsRead } from "../src/updates/ledger";
import { PreferencesStore } from "../src/storage/preferences";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const summary: IssueSummary = { id: "1" as IssueSummary["id"], key: "DEV-1" as IssueSummary["key"], summary: "A ticket", status: "Open", statusCategory: "to_do", priority: "Medium", assignee: "Unassigned", updated: "2026-01-01" };
const detail: IssueDetail = { issue: summary, issueType: "Task", reporter: "Ada", project: "DEV", parent: null, labels: [], dueDate: null, created: "2026-01-01", description: "Description", comments: [], attachments: [], remote: true };
const teamSummary: IssueSummary = { id: "2" as IssueSummary["id"], key: "TEAM-2" as IssueSummary["key"], summary: "Team ticket", status: "In Progress", statusCategory: "in_progress", priority: "High", assignee: "Grace", updated: "2026-02-01" };

/** Keep all backend fakes honest as the façade requires the team read port. */
function withTeamPort<T extends object>(jira: T): T & JiraTeamReadPort {
  const candidate = jira as T & Partial<JiraTeamReadPort>;
  if (!candidate.resolveTeamMember) candidate.resolveTeamMember = async (identifier: string) => ({ accountId: identifier.includes("@") ? "acct-email" : identifier.trim(), displayName: identifier });
  if (!candidate.searchTeamIssues) candidate.searchTeamIssues = async () => [];
  return jira as T & JiraTeamReadPort;
}

function fixture() {
  const dir = `/tmp/jira-desk-backend-${crypto.randomUUID()}`; dirs.push(dir); mkdirSync(dir, { recursive: true });
  const env = { XDG_DATA_HOME: dir };
  let searches = 0;
  const jira = { async myself() { return { accountId: "acct-1", displayName: "Ada" }; }, async searchAssignedOrWatched() { searches += 1; return [summary]; }, async issueDetail() { return detail; } };
  return { jira, cache: new IssueCache(join(dir, "jira-desk.sqlite3")), env, get searches() { return searches; } };
}

function testCredentials(): SystemCredentialStore {
  return {
    async load() { return { kind: "ok", value: null } as CredentialResult<SavedCredentials | null>; },
    async save() { return { kind: "ok", value: true } as const; },
    async delete() { return { kind: "ok", value: true } as const; },
  } as unknown as SystemCredentialStore;
}

function scopeBackendFixture(results: Record<string, readonly IssueSummary[]>) {
  const dir = `/tmp/jira-desk-scope-backend-${crypto.randomUUID()}`;
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  const env = { XDG_DATA_HOME: dir };
  const cache = new IssueCache(join(dir, "cache.sqlite3"));
  const preferences = new PreferencesStore(env);
  const calls: (string | undefined)[] = [];
  const jira = {
    async myself() { return { accountId: "acct-1", displayName: "Ada" }; },
    async searchAssignedOrWatched(options?: { scope?: string }) {
      const scope = typeof options === "object" ? options?.scope : undefined;
      calls.push(scope);
      return results[scope ?? "default"] ?? [];
    },
    async issueDetail() { return detail; },
  };
  const backend = new JiraDeskBackend({ cache, credentials: testCredentials(), env, preferences, jiraFactory: () => withTeamPort(jira) });
  return { dir, env, cache, preferences, jira, backend, calls };
}

function teamBackendFixture() {
  const dir = `/tmp/jira-desk-team-backend-${crypto.randomUUID()}`;
  dirs.push(dir); mkdirSync(dir, { recursive: true });
  const env = { XDG_DATA_HOME: dir };
  const cache = new IssueCache(join(dir, "cache.sqlite3"));
  const preferences = new PreferencesStore(env);
  const resolved: string[] = [];
  const teamCalls: string[][] = [];
  const jira = withTeamPort({
    async myself() { return { accountId: "acct-1", displayName: "Ada" }; },
    async searchAssignedOrWatched() { return [summary]; },
    async issueDetail() { return detail; },
    async resolveTeamMember(identifier: string) {
      resolved.push(identifier);
      return { accountId: identifier.includes("@") ? "acct-email" : identifier.trim(), displayName: identifier };
    },
    async searchTeamIssues(accountIds: readonly string[]) {
      teamCalls.push([...accountIds]);
      return [teamSummary];
    },
  });
  const backend = new JiraDeskBackend({ cache, credentials: testCredentials(), env, preferences, jiraFactory: () => jira });
  return { dir, env, cache, preferences, jira, backend, resolved, teamCalls };
}

describe("Workspace", () => {
  test("verifies identity before reading account-scoped cache and refreshes after success", async () => {
    const fixtureData = fixture();
    const workspace = await Workspace.connect(fixtureData.jira, fixtureData.cache, { siteId: "site-1", siteLabel: "Example" });
    expect(workspace.identity.accountId).toBe("acct-1"); expect(workspace.cachedSnapshot()).toEqual([]);
    const snapshot = await workspace.refresh();
    expect(snapshot.source).toBe("jira"); expect(snapshot.issues).toEqual([summary]); expect(fixtureData.searches).toBe(1);
    expect(await workspace.detail(" dev-1 ")).toEqual({ ...detail, remote: false });
  });

  test("does not permit an uncached non-remote detail", async () => {
    const fixtureData = fixture();
    const workspace = await Workspace.connect(fixtureData.jira, fixtureData.cache, { siteId: "site-1" });
    expect(workspace.detail("DEV-1")).rejects.toMatchObject({ code: "not_found" });
    expect(await workspace.detail("DEV-1", true)).toEqual(detail);
  });

  test("quietly establishes the first baseline, then persists a derived diff", async () => {
    const fixtureData = fixture();
    let current = summary;
    const jira = {
      async myself() { return { accountId: "acct-1", displayName: "Ada" }; },
      async searchAssignedOrWatched() { return [current]; },
      async issueDetail() { return detail; },
    };
    const workspace = await Workspace.connect(jira, fixtureData.cache, { siteId: "site-1" });
    const first = await workspace.refresh();
    expect(first.updates.events).toEqual([]);
    expect(first.updatesBaselineEstablished).toBe(true);

    current = { ...summary, summary: "Changed", updated: "2026-02-01" };
    const second = await workspace.refresh();
    expect(second.updates.events).toHaveLength(1);
    const read = markGroupsRead(second.updates, [summary.id], true, [summary.id]);
    const persisted = workspace.persistUpdateLedger(read);
    expect(persisted.readIssueIds).toEqual([summary.id]);
  });

  test("loads the workspace only during connect; refresh uses the atomic commit result", async () => {
    const fixtureData = fixture();
    const originalLoad = fixtureData.cache.loadWorkspace.bind(fixtureData.cache);
    let loads = 0;
    fixtureData.cache.loadWorkspace = ((identity) => {
      loads += 1;
      return originalLoad(identity);
    }) as typeof fixtureData.cache.loadWorkspace;
    try {
      const workspace = await Workspace.connect(fixtureData.jira, fixtureData.cache, { siteId: "site-1" });
      expect(loads).toBe(1);
      await workspace.refresh();
      expect(loads).toBe(1);
    } finally {
      fixtureData.cache.loadWorkspace = originalLoad;
    }
  });

  test("does not mutate the workspace when atomic refresh persistence fails", async () => {
    const fixtureData = fixture();
    fixtureData.cache.replace({ siteId: "site-1", accountId: "acct-1" }, [summary]);
    const workspace = await Workspace.connect(fixtureData.jira, fixtureData.cache, { siteId: "site-1" });
    const before = workspace.initialSnapshot();
    const cache = fixtureData.cache as IssueCache & { commitWorkspace: IssueCache["commitWorkspace"] };
    const originalCommit = cache.commitWorkspace;
    cache.commitWorkspace = (() => { throw new Error("atomic commit failed"); }) as typeof originalCommit;
    try {
      await expect(workspace.refresh()).rejects.toMatchObject({ code: "storage" });
    } finally {
      cache.commitWorkspace = originalCommit;
    }
    const after = workspace.initialSnapshot();
    expect(after.issues).toEqual(before.issues);
    expect(after.updates).toEqual(before.updates);
    expect(after.updatesBaselineEstablished).toBe(before.updatesBaselineEstablished);
  });

  test("leaves the workspace unchanged when Jira refresh fails", async () => {
    const fixtureData = fixture();
    let fail = false;
    const jira = {
      async myself() { return { accountId: "acct-1", displayName: "Ada" }; },
      async searchAssignedOrWatched() {
        if (fail) throw new Error("offline");
        return [summary];
      },
      async issueDetail() { return detail; },
    };
    const workspace = await Workspace.connect(jira, fixtureData.cache, { siteId: "site-1" });
    await workspace.refresh();
    const before = workspace.initialSnapshot();
    fail = true;
    await expect(workspace.refresh()).rejects.toMatchObject({ code: "transport" });
    const after = workspace.initialSnapshot();
    expect(after.issues).toEqual(before.issues);
    expect(after.updates).toEqual(before.updates);
    expect(after.updatesBaselineEstablished).toBe(before.updatesBaselineEstablished);
  });
});

describe("JiraDeskBackend", () => {
  test("loads a cached canonical team partition without a Jira team call and restores it on restart", async () => {
    const fixtureData = teamBackendFixture();
    fixtureData.preferences.save({ teamMembers: ["acct-2"] });
    const teamSite = teamPartitionSiteId("example.atlassian.net", ["acct-2"]);
    fixtureData.cache.commitWorkspace({ siteId: teamSite, accountId: "acct-1" }, [teamSummary], emptyUpdateLedger(), true);
    const first = await fixtureData.backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token", cloudId: "cloud-123", remember: false });
    expect(fixtureData.backend.teamSnapshot()).toMatchObject({ source: "cache", issues: [teamSummary] });
    expect(fixtureData.teamCalls).toEqual([]);
    fixtureData.backend.close();
    const second = new JiraDeskBackend({ cache: new IssueCache(join(fixtureData.dir, "cache.sqlite3")), credentials: testCredentials(), env: fixtureData.env, preferences: new PreferencesStore(fixtureData.env), jiraFactory: () => fixtureData.jira });
    await second.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token", cloudId: "cloud-123", remember: false });
    expect(second.teamSnapshot()).toMatchObject({ source: "cache", issues: [teamSummary] });
    expect(fixtureData.teamCalls).toEqual([]);
    expect(first.source).toBe("jira");
    second.close();
  });

  test("keeps an empty team local and never calls Jira, including refresh", async () => {
    const fixtureData = teamBackendFixture();
    await fixtureData.backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token", cloudId: "cloud-123", remember: false });
    expect(fixtureData.backend.teamSnapshot()).toMatchObject({ source: "local", issues: [] });
    expect(await fixtureData.backend.refreshTeam()).toMatchObject({ source: "local", issues: [] });
    expect(fixtureData.resolved).toEqual([]);
    expect(fixtureData.teamCalls).toEqual([]);
    fixtureData.backend.close();
  });

  test("refreshes the active team remotely and keeps its update ledger isolated", async () => {
    const fixtureData = teamBackendFixture();
    fixtureData.preferences.save({ teamMembers: ["acct-2"] });
    await fixtureData.backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token", cloudId: "cloud-123", remember: false });
    const refreshed = await fixtureData.backend.refreshTeam();
    expect(refreshed).toMatchObject({ source: "jira", issues: [teamSummary] });
    expect(fixtureData.teamCalls).toEqual([["acct-2"]]);
    const teamState = fixtureData.cache.loadWorkspace({ siteId: teamPartitionSiteId("example.atlassian.net", ["acct-2"]), accountId: "acct-1" });
    expect(teamState.updates).toEqual(emptyUpdateLedger());
    expect((await fixtureData.backend.refresh()).updates).toEqual(expect.any(Object));
    fixtureData.backend.close();
  });

  test("resolves in input order, deduplicates stable IDs, and saves canonical accounts after cache commit", async () => {
    const fixtureData = teamBackendFixture();
    await fixtureData.backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token", cloudId: "cloud-123", remember: false });
    const order: string[] = [];
    const commit = fixtureData.cache.commitWorkspace.bind(fixtureData.cache);
    fixtureData.cache.commitWorkspace = ((identity, issues, updates, baseline) => { order.push("cache"); return commit(identity, issues, updates, baseline); }) as typeof fixtureData.cache.commitWorkspace;
    const save = fixtureData.preferences.save.bind(fixtureData.preferences);
    fixtureData.preferences.save = ((input) => { order.push("preferences"); return save(input); }) as typeof fixtureData.preferences.save;
    const result = await fixtureData.backend.applyTeamMembers(["acct-a", "ada@example.test", "acct-a"]);
    expect(fixtureData.resolved).toEqual(["acct-a", "ada@example.test"]);
    expect(fixtureData.teamCalls.at(-1)).toEqual(["acct-a", "acct-email"]);
    expect(result.preferences.teamMembers).toEqual(["acct-a", "acct-email"]);
    expect(order).toEqual(["cache", "preferences"]);
    expect(fixtureData.backend.teamSnapshot().source).toBe("jira");
    fixtureData.backend.close();
  });

  test("rejects unsafe or oversized raw identifiers locally before any Jira resolution", async () => {
    const fixtureData = teamBackendFixture();
    await fixtureData.backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token", cloudId: "cloud-123", remember: false });
    for (const identifiers of [["   "], ["bad\nidentifier"], ["é".repeat(161)], Array.from({ length: 101 }, (_, index) => `acct-${index}`)]) {
      await expect(fixtureData.backend.applyTeamMembers(identifiers)).rejects.toMatchObject({ category: "invalid_input" });
    }
    expect(fixtureData.resolved).toEqual([]);
    expect(fixtureData.teamCalls).toEqual([]);
    fixtureData.backend.close();
  });

  test("retains the active team on resolution, fetch, cache, preference, and cancellation failures", async () => {
    const fixtureData = teamBackendFixture();
    await fixtureData.backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token", cloudId: "cloud-123", remember: false });
    await fixtureData.backend.applyTeamMembers(["acct-old"]);
    const before = fixtureData.backend.teamSnapshot();
    fixtureData.jira.resolveTeamMember = async () => { throw new Error("resolve failed"); };
    await expect(fixtureData.backend.applyTeamMembers(["acct-new"])).rejects.toMatchObject({ category: "internal" });
    expect(fixtureData.backend.teamSnapshot()).toEqual(before);
    fixtureData.jira.resolveTeamMember = async (identifier: string) => ({ accountId: identifier, displayName: identifier });
    fixtureData.jira.searchTeamIssues = async () => { throw new Error("fetch failed"); };
    await expect(fixtureData.backend.applyTeamMembers(["acct-new"])).rejects.toMatchObject({ category: "internal" });
    expect(fixtureData.backend.teamSnapshot()).toEqual(before);
    fixtureData.jira.searchTeamIssues = async () => [teamSummary];
    const originalCommit = fixtureData.cache.commitWorkspace.bind(fixtureData.cache);
    fixtureData.cache.commitWorkspace = (() => { throw new Error("cache failed"); }) as typeof fixtureData.cache.commitWorkspace;
    await expect(fixtureData.backend.applyTeamMembers(["acct-new"])).rejects.toMatchObject({ category: "storage" });
    fixtureData.cache.commitWorkspace = originalCommit;
    const originalSave = fixtureData.preferences.save.bind(fixtureData.preferences);
    fixtureData.preferences.save = (() => { throw new Error("preferences failed"); }) as typeof fixtureData.preferences.save;
    await expect(fixtureData.backend.applyTeamMembers(["acct-new"])).rejects.toMatchObject({ category: "internal" });
    expect(fixtureData.preferences.load().teamMembers).toEqual(["acct-old"]);
    expect(fixtureData.backend.teamSnapshot()).toEqual(before);
    fixtureData.preferences.save = originalSave;
    const controller = new AbortController();
    fixtureData.jira.resolveTeamMember = async () => { controller.abort(); return { accountId: "acct-cancel", displayName: "Cancel" }; };
    await expect(fixtureData.backend.applyTeamMembers(["acct-cancel"], controller.signal)).rejects.toMatchObject({ category: "cancelled" });
    expect(fixtureData.backend.teamSnapshot()).toEqual(before);
    fixtureData.backend.close();
  });

  test("guards team operations before authentication and preserves the old replacement connection", async () => {
    const fixtureData = teamBackendFixture();
    const unauthenticated = new JiraDeskBackend({ cache: new IssueCache(join(fixtureData.dir, "unauthenticated.sqlite3")), credentials: testCredentials(), env: fixtureData.env, jiraFactory: () => fixtureData.jira });
    expect(() => unauthenticated.teamSnapshot()).toThrow(expect.objectContaining({ category: "authentication" }));
    await expect(unauthenticated.refreshTeam()).rejects.toMatchObject({ category: "authentication" });
    await expect(unauthenticated.applyTeamMembers([])).rejects.toMatchObject({ category: "authentication" });
    unauthenticated.close();
    const original = await fixtureData.backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "old", cloudId: "cloud-123", remember: false });
    const controller = new AbortController();
    const replacement = withTeamPort({
      async myself() { return { accountId: "acct-replacement", displayName: "Replacement" }; },
      async searchAssignedOrWatched() { controller.abort(); return [teamSummary]; },
      async issueDetail() { return detail; },
    });
    const replacementBackend = new JiraDeskBackend({ cache: fixtureData.cache, credentials: testCredentials(), env: fixtureData.env, jiraFactory: (_base, _email, token) => token === "old" ? fixtureData.jira : replacement });
    await replacementBackend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "old", cloudId: "cloud-123", remember: false });
    await expect(replacementBackend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "new", cloudId: "cloud-123", remember: false }, controller.signal)).rejects.toMatchObject({ category: "cancelled" });
    expect((await replacementBackend.refresh()).issues).toEqual(original.issues);
    replacementBackend.close();
    fixtureData.backend.close();
  });

  test("TeamWorkspace applies raw validation without Jira and preserves a committed candidate source", async () => {
    const fixtureData = teamBackendFixture();
    const workspace = TeamWorkspace.connect(fixtureData.jira, fixtureData.cache, { siteId: "example.atlassian.net", accountId: "acct-1", memberAccountIds: [] });
    await expect(workspace.prepareTeamMembers(["bad\u0000id"])).rejects.toMatchObject({ code: "invalid_input" });
    expect(fixtureData.resolved).toEqual([]);
    const candidate = await workspace.prepareTeamMembers(["acct-direct"]);
    expect(candidate.snapshot.source).toBe("jira");
    const active = workspace.activateTeamMembers(candidate);
    expect(active.source).toBe("jira");
    expect(active.refreshedAt).toBe(candidate.snapshot.refreshedAt);
    fixtureData.cache.close();
  });

  test("connects with persisted scope and reads its opaque partition", async () => {
    const scoped = { ...summary, key: "SCOPE-1" as IssueSummary["key"] };
    const fixtureData = scopeBackendFixture({ default: [summary], "project = DEV": [scoped] });
    fixtureData.preferences.save({ jqlScope: " project = DEV ", teamMembers: [], theme: "Dark", noColor: true, asciiOnly: false });
    const identities: string[] = [];
    const originalLoad = fixtureData.cache.loadWorkspace.bind(fixtureData.cache);
    fixtureData.cache.loadWorkspace = ((identity) => { identities.push(identity.siteId); return originalLoad(identity); }) as typeof fixtureData.cache.loadWorkspace;
    const snapshot = await fixtureData.backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token", cloudId: "cloud-123", remember: false });
    expect(snapshot.issues).toEqual([scoped]);
    expect(fixtureData.calls).toEqual(["project = DEV"]);
    expect(identities[0]).toBe(scopePartitionSiteId("example.atlassian.net", "project = DEV"));
    expect(identities[0]).not.toContain("project = DEV");
    fixtureData.backend.close();
  });

  test("commits a new scope before saving preferences and keeps independent ledgers", async () => {
    const changed = { ...summary, summary: "Changed", updated: "2026-02-01" };
    const scoped = { ...summary, key: "SCOPE-1" as IssueSummary["key"], summary: "Scoped" };
    const results: Record<string, readonly IssueSummary[]> = { default: [summary], "project = DEV": [scoped] };
    const fixtureData = scopeBackendFixture(results);
    await fixtureData.backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token", cloudId: "cloud-123", remember: false });
    results.default = [changed];
    const defaultChanged = await fixtureData.backend.refresh();
    fixtureData.backend.persistUpdateLedger(markGroupsRead(defaultChanged.updates, [summary.id], true, [summary.id]));

    const order: string[] = [];
    const originalCommit = fixtureData.cache.commitWorkspace.bind(fixtureData.cache);
    fixtureData.cache.commitWorkspace = ((identity, issues, updates, baseline) => { order.push("cache"); return originalCommit(identity, issues, updates, baseline); }) as typeof fixtureData.cache.commitWorkspace;
    const originalSave = fixtureData.preferences.save.bind(fixtureData.preferences);
    fixtureData.preferences.save = ((input) => { order.push("preferences"); return originalSave(input); }) as typeof fixtureData.preferences.save;
    const switched = await fixtureData.backend.applyJqlScope("  project = DEV  ");
    expect(order).toEqual(["cache", "preferences"]);
    expect(switched.snapshot.issues).toEqual([scoped]);
    expect(switched.snapshot.updates.events).toEqual([]);
    expect(switched.preferences.jqlScope).toBe("project = DEV");
    expect(switched.preferences.theme).toBe("System");
    expect(fixtureData.calls.at(-1)).toBe("project = DEV");

    const refreshed = await fixtureData.backend.refresh();
    expect(refreshed.issues).toEqual([scoped]);
    expect(fixtureData.calls.at(-1)).toBe("project = DEV");

    const back = await fixtureData.backend.applyJqlScope(undefined);
    expect(back.preferences.jqlScope).toBeUndefined();
    expect(back.snapshot.updates.events).toHaveLength(1);
    expect(back.snapshot.updates.readIssueIds).toEqual([summary.id]);
    fixtureData.backend.close();
  });

  test("rejects invalid scopes locally without a Jira search", async () => {
    const fixtureData = scopeBackendFixture({ default: [summary], "project = DEV": [summary] });
    await fixtureData.backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token", cloudId: "cloud-123", remember: false });
    fixtureData.calls.length = 0;
    for (const invalid of ["", "   ", "project = DEV ORDER BY updated DESC", "project = DEV\n", "é".repeat(1001)]) {
      await expect(fixtureData.backend.applyJqlScope(invalid)).rejects.toMatchObject({ category: "invalid_input" });
    }
    expect(fixtureData.calls).toEqual([]);
    fixtureData.backend.close();
  });

  test("preserves the active workspace on Jira and target cache failures", async () => {
    const scoped = { ...summary, key: "SCOPE-1" as IssueSummary["key"] };
    const results: Record<string, readonly IssueSummary[]> = { default: [summary], "project = DEV": [scoped] };
    const fixtureData = scopeBackendFixture(results);
    await fixtureData.backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token", cloudId: "cloud-123", remember: false });

    results["project = DEV"] = [];
    const originalJiraSearch = fixtureData.jira.searchAssignedOrWatched;
    fixtureData.jira.searchAssignedOrWatched = async (options?: { scope?: string }) => {
      if (options?.scope === "project = DEV") throw new Error("offline");
      return originalJiraSearch(options);
    };
    await expect(fixtureData.backend.applyJqlScope("project = DEV")).rejects.toMatchObject({ category: "internal" });
    expect(fixtureData.preferences.load().jqlScope).toBeUndefined();
    expect((await fixtureData.backend.refresh()).issues).toEqual([summary]);

    fixtureData.jira.searchAssignedOrWatched = originalJiraSearch;
    const originalCommit = fixtureData.cache.commitWorkspace.bind(fixtureData.cache);
    const targetSite = scopePartitionSiteId("example.atlassian.net", "project = DEV");
    fixtureData.cache.commitWorkspace = ((identity, issues, updates, baseline) => {
      if (identity.siteId === targetSite) throw new Error("target cache unavailable");
      return originalCommit(identity, issues, updates, baseline);
    }) as typeof fixtureData.cache.commitWorkspace;
    await expect(fixtureData.backend.applyJqlScope("project = DEV")).rejects.toMatchObject({ category: "storage" });
    expect((await fixtureData.backend.refresh()).issues).toEqual([summary]);
    fixtureData.backend.close();
  });

  test("retains old preferences when target commit succeeds but preference save fails", async () => {
    const scoped = { ...summary, key: "SCOPE-1" as IssueSummary["key"] };
    const fixtureData = scopeBackendFixture({ default: [summary], "project = DEV": [scoped] });
    await fixtureData.backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token", cloudId: "cloud-123", remember: false });
    const originalSave = fixtureData.preferences.save.bind(fixtureData.preferences);
    fixtureData.preferences.save = (() => { throw new Error("preference disk full"); }) as typeof fixtureData.preferences.save;
    await expect(fixtureData.backend.applyJqlScope("project = DEV")).rejects.toMatchObject({ category: "internal" });
    expect(fixtureData.preferences.load().jqlScope).toBeUndefined();
    expect((await fixtureData.backend.refresh()).issues).toEqual([summary]);
    const target = fixtureData.cache.loadWorkspace({ siteId: scopePartitionSiteId("example.atlassian.net", "project = DEV"), accountId: "acct-1" });
    expect(target.issues).toEqual([scoped]);
    fixtureData.preferences.save = originalSave;
    fixtureData.backend.close();
  });

  test("cancels scope switching without publishing it", async () => {
    const fixtureData = scopeBackendFixture({ default: [summary], "project = DEV": [summary] });
    await fixtureData.backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token", cloudId: "cloud-123", remember: false });
    const controller = new AbortController();
    const originalSearch = fixtureData.jira.searchAssignedOrWatched;
    fixtureData.jira.searchAssignedOrWatched = async (options?: { scope?: string }) => {
      if (options?.scope === "project = DEV") controller.abort();
      return originalSearch(options);
    };
    await expect(fixtureData.backend.applyJqlScope("project = DEV", controller.signal)).rejects.toMatchObject({ category: "cancelled" });
    expect(fixtureData.preferences.load().jqlScope).toBeUndefined();
    expect((await fixtureData.backend.refresh()).issues).toEqual([summary]);
    fixtureData.backend.close();
  });

  test("restarts using the successfully saved scope partition", async () => {
    const scoped = { ...summary, key: "SCOPE-1" as IssueSummary["key"] };
    const fixtureData = scopeBackendFixture({ default: [summary], "project = DEV": [scoped] });
    await fixtureData.backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token", cloudId: "cloud-123", remember: false });
    await fixtureData.backend.applyJqlScope("project = DEV");
    fixtureData.calls.length = 0;
    fixtureData.backend.close();
    const second = new JiraDeskBackend({
      cache: new IssueCache(join(fixtureData.dir, "cache.sqlite3")),
      credentials: testCredentials(),
      env: fixtureData.env,
      preferences: new PreferencesStore(fixtureData.env),
      jiraFactory: () => withTeamPort(fixtureData.jira),
    });
    const restored = await second.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token", cloudId: "cloud-123", remember: false });
    expect(restored.source).toBe("cache");
    expect(restored.issues).toEqual([scoped]);
    expect(fixtureData.calls).toEqual([]);
    second.close();
  });

  test("loads default preferences and round-trips appearance across backend instances", () => {
    const dir = `/tmp/jira-desk-preferences-backend-${crypto.randomUUID()}`;
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const env = { XDG_DATA_HOME: dir };
    const first = new JiraDeskBackend({ env, cache: new IssueCache(join(dir, "first.sqlite3")), preferences: new PreferencesStore(env) });

    expect(first.loadPreferences()).toEqual({ version: 1, teamMembers: [], theme: "System", noColor: false, asciiOnly: false });
    expect(first.saveAppearancePreferences({ theme: "Dark", noColor: true, asciiOnly: true })).toEqual({ version: 1, teamMembers: [], theme: "Dark", noColor: true, asciiOnly: true });
    first.close();

    const second = new JiraDeskBackend({ env, cache: new IssueCache(join(dir, "second.sqlite3")), preferences: new PreferencesStore(env) });
    expect(second.loadPreferences()).toEqual({ version: 1, teamMembers: [], theme: "Dark", noColor: true, asciiOnly: true });
    second.close();
  });

  test("preserves JQL scope and team members when saving appearance", () => {
    const dir = `/tmp/jira-desk-preferences-preserve-${crypto.randomUUID()}`;
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const env = { XDG_DATA_HOME: dir };
    const preferences = new PreferencesStore(env);
    preferences.save({ jqlScope: "project = DEV", teamMembers: ["ada@example.test", "grace@example.test"], theme: "Light", noColor: false, asciiOnly: false });
    const backend = new JiraDeskBackend({ env, cache: new IssueCache(join(dir, "cache.sqlite3")), preferences });

    expect(backend.saveAppearancePreferences({ theme: "Dark", noColor: true, asciiOnly: true })).toEqual({
      version: 1,
      jqlScope: "project = DEV",
      teamMembers: ["ada@example.test", "grace@example.test"],
      theme: "Dark",
      noColor: true,
      asciiOnly: true,
    });
    backend.close();
  });

  test("maps invalid and unsafe preference failures without exposing storage details", () => {
    const invalidDir = `/tmp/jira-desk-preferences-invalid-${crypto.randomUUID()}`;
    const unsafeDir = `/tmp/jira-desk-preferences-unsafe-${crypto.randomUUID()}`;
    dirs.push(invalidDir, unsafeDir);
    mkdirSync(invalidDir, { recursive: true });
    mkdirSync(unsafeDir, { recursive: true });
    const invalidEnv = { XDG_DATA_HOME: invalidDir };
    const invalid = new JiraDeskBackend({ env: invalidEnv, cache: new IssueCache(join(invalidDir, "cache.sqlite3")), preferences: new PreferencesStore(invalidEnv) });
    expect(() => invalid.saveAppearancePreferences({ theme: "Nope" as "System", noColor: false, asciiOnly: false })).toThrow(
      expect.objectContaining({ category: "invalid_input", message: "Preferences are invalid" }),
    );
    invalid.close();

    const preferencesDir = join(unsafeDir, "jira-desk");
    mkdirSync(preferencesDir, { recursive: true });
    const target = join(unsafeDir, "outside-preferences.json");
    symlinkSync(target, join(preferencesDir, "preferences.json"));
    const unsafeEnv = { XDG_DATA_HOME: unsafeDir };
    const unsafe = new JiraDeskBackend({ env: unsafeEnv, cache: new IssueCache(join(unsafeDir, "cache.sqlite3")), preferences: new PreferencesStore(unsafeEnv) });
    expect(() => unsafe.saveAppearancePreferences({ theme: "Dark", noColor: false, asciiOnly: false })).toThrow(
      expect.objectContaining({ category: "storage", message: "Unable to access local preferences" }),
    );
    try {
      unsafe.saveAppearancePreferences({ theme: "Dark", noColor: false, asciiOnly: false });
    } catch (error) {
      expect(String(error)).not.toContain(target);
    }
    unsafe.close();
  });

  test("does not affect the current Jira workspace", async () => {
    const fixtureData = fixture();
    const dir = `/tmp/jira-desk-preferences-workspace-${crypto.randomUUID()}`;
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const env = { XDG_DATA_HOME: dir };
    const backend = new JiraDeskBackend({ env, cache: fixtureData.cache, preferences: new PreferencesStore(env), jiraFactory: () => withTeamPort(fixtureData.jira) });
    const connected = await backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "secret-token", cloudId: "cloud-123", remember: false });
    backend.saveAppearancePreferences({ theme: "Light", noColor: true, asciiOnly: false });
    const refreshed = await backend.refresh();
    expect(refreshed.issues).toEqual(connected.issues);
    expect(refreshed.identity).toBe(connected.identity);
    backend.close();
  });

  test("connects through a Jira port, returns domain snapshots, and never returns credentials", async () => {
    const fixtureData = fixture();
    const credentialStore = { async load() { return { kind: "ok", value: null } as CredentialResult<SavedCredentials | null>; }, async save() { return { kind: "ok", value: true } as const; }, async delete() { return { kind: "ok", value: true } as const; } } as unknown as SystemCredentialStore;
    const backend = new JiraDeskBackend({ cache: fixtureData.cache, credentials: credentialStore, env: fixtureData.env, jiraFactory: () => withTeamPort(fixtureData.jira) });
    const snapshot = await backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "secret-token", cloudId: "cloud-123", remember: false });
    expect(snapshot.identity).toBe("Ada");
    expect(snapshot.issues[0]?.key as string | undefined).toBe("DEV-1");
    expect(JSON.stringify(snapshot)).not.toContain("secret-token");
    backend.close();
  });

  test("restores a remembered login across backend sessions without reconfiguration", async () => {
    const dir = `/tmp/jira-desk-remember-${crypto.randomUUID()}`;
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const databasePath = join(dir, "jira-desk.sqlite3");
    let nativeValue: string | null = null;
    const provider: SecretProvider = {
      async get() { return nativeValue; },
      async set(options) { nativeValue = options.value; },
      async delete() { nativeValue = null; return true; },
    };
    const credentialStore = new SystemCredentialStore(provider);
    const jiraFixture = fixture();
    const jira = jiraFixture.jira;
    jiraFixture.cache.close();

    const first = new JiraDeskBackend({
      cache: new IssueCache(databasePath),
      credentials: credentialStore,
      env: jiraFixture.env,
      jiraFactory: () => withTeamPort(jira),
    });
    await first.connect({
      baseUrl: "https://example.atlassian.net",
      email: "ada@example.test",
      token: "secret-token",
      cloudId: "cloud-123",
      remember: true,
    });
    first.close();
    expect(nativeValue).not.toBeNull();
    expect(String(nativeValue)).toContain("cloud-123");

    const second = new JiraDeskBackend({
      cache: new IssueCache(databasePath),
      credentials: credentialStore,
      env: jiraFixture.env,
      jiraFactory: () => withTeamPort(jira),
    });
    const restored = await second.bootstrap();
    expect(restored.state).toBe("authenticated");
    if (restored.state !== "authenticated") throw new Error("saved login was not restored");
    expect(restored.snapshot.source).toBe("cache");
    expect(restored.snapshot.issues[0]?.key as string | undefined).toBe("DEV-1");
    expect(JSON.stringify(restored.snapshot)).not.toContain("secret-token");
    second.close();
  });

  test("restores persisted update events and read state across backend sessions", async () => {
    const dir = `/tmp/jira-desk-updates-${crypto.randomUUID()}`;
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const databasePath = join(dir, "jira-desk.sqlite3");
    let current = summary;
    const jira = {
      async myself() { return { accountId: "acct-1", displayName: "Ada" }; },
      async searchAssignedOrWatched() { return [current]; },
      async issueDetail() { return detail; },
    };
    const credentials = {
      async load() { return { kind: "ok", value: null } as CredentialResult<SavedCredentials | null>; },
      async save() { return { kind: "ok", value: true } as const; },
      async delete() { return { kind: "ok", value: true } as const; },
    } as unknown as SystemCredentialStore;
    const first = new JiraDeskBackend({ cache: new IssueCache(databasePath), credentials, env: { XDG_DATA_HOME: dir }, jiraFactory: () => withTeamPort(jira) });
    await first.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "secret-token", cloudId: "cloud-123", remember: false });
    current = { ...summary, summary: "Changed", updated: "2026-02-01" };
    const changed = await first.refresh();
    const read = markGroupsRead(changed.updates, [summary.id], true, [summary.id]);
    first.persistUpdateLedger(read);
    first.close();

    const second = new JiraDeskBackend({ cache: new IssueCache(databasePath), credentials, env: { XDG_DATA_HOME: dir }, jiraFactory: () => withTeamPort(jira) });
    const restored = await second.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "secret-token", cloudId: "cloud-123", remember: false });
    expect(restored.source).toBe("cache");
    expect(restored.updates.events).toHaveLength(1);
    expect(restored.updates.readIssueIds).toEqual([summary.id]);
    second.close();
  });

  test("requires authentication to persist local updates", () => {
    const fixtureData = fixture();
    const backend = new JiraDeskBackend({ cache: fixtureData.cache, env: fixtureData.env, jiraFactory: () => withTeamPort(fixtureData.jira) });
    expect(() => backend.persistUpdateLedger(emptyUpdateLedger())).toThrow(
      expect.objectContaining({ category: "authentication" }),
    );
    backend.close();
  });

  test("rejects a partial environment tuple safely", async () => {
    const fixtureData = fixture();
    const credentialStore = new SystemCredentialStore({
      async get() { return null; },
      async set() {},
      async delete() { return false; },
    });
    const backend = new JiraDeskBackend({
      cache: fixtureData.cache,
      credentials: credentialStore,
      env: { JIRA_BASE_URL: "https://example.atlassian.net" },
      jiraFactory: () => withTeamPort(fixtureData.jira),
    });
    await expect(backend.bootstrap()).rejects.toMatchObject({ category: "invalid_input" });
    backend.close();
  });

  test("does not publish a workspace when connect is aborted after its initial refresh", async () => {
    const fixtureData = fixture();
    const controller = new AbortController();
    const jira = {
      async myself() { return { accountId: "acct-1", displayName: "Ada" }; },
      async searchAssignedOrWatched(options: { signal?: AbortSignal }) {
        options.signal?.throwIfAborted?.();
        controller.abort();
        return [summary];
      },
      async issueDetail() { return detail; },
    };
    const credentialStore = {
      async load() { return { kind: "ok", value: null } as CredentialResult<SavedCredentials | null>; },
      async save() { return { kind: "ok", value: true } as const; },
      async delete() { return { kind: "ok", value: true } as const; },
    } as unknown as SystemCredentialStore;
    const backend = new JiraDeskBackend({ cache: fixtureData.cache, credentials: credentialStore, env: fixtureData.env, jiraFactory: () => withTeamPort(jira) });

    await expect(backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "secret-token", cloudId: "cloud-123", remember: false }, controller.signal)).rejects.toMatchObject({ category: "cancelled", message: "Connection cancelled" });
    await expect(backend.refresh()).rejects.toMatchObject({ category: "authentication" });
    await expect(backend.loadDetail("DEV-1")).rejects.toMatchObject({ category: "authentication" });
    backend.close();
  });

  test("keeps an existing workspace usable when a replacement connect is cancelled", async () => {
    const fixtureData = fixture();
    const replacementController = new AbortController();
    const originalSummary = { ...summary, summary: "Original workspace ticket" };
    const replacementSummary = { ...summary, key: "NEW-2" as IssueSummary["key"], summary: "Cancelled replacement ticket" };
    const originalDetail = { ...detail, description: "Original workspace detail" };
    const originalJira = {
      async myself() { return { accountId: "acct-1", displayName: "Ada" }; },
      async searchAssignedOrWatched() { return [originalSummary]; },
      async issueDetail() { return originalDetail; },
    };
    const replacementJira = {
      async myself() { return { accountId: "acct-2", displayName: "Replacement" }; },
      async searchAssignedOrWatched() {
        replacementController.abort();
        return [replacementSummary];
      },
      async issueDetail() { throw new Error("cancelled replacement client was retained"); },
    };
    const credentialStore = {
      async load() { return { kind: "ok", value: null } as CredentialResult<SavedCredentials | null>; },
      async save() { return { kind: "ok", value: true } as const; },
      async delete() { return { kind: "ok", value: true } as const; },
    } as unknown as SystemCredentialStore;
    const backend = new JiraDeskBackend({
      cache: fixtureData.cache,
      credentials: credentialStore,
      env: fixtureData.env,
      jiraFactory: (_baseUrl, _email, token) => token === "old-token" ? withTeamPort(originalJira) : withTeamPort(replacementJira),
    });

    const original = await backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "old-token", cloudId: "cloud-123", remember: false });
    expect(original.issues[0]?.summary).toBe("Original workspace ticket");
    await expect(backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "replacement-token", cloudId: "cloud-123", remember: false }, replacementController.signal)).rejects.toMatchObject({ category: "cancelled" });

    const refreshed = await backend.refresh();
    expect(refreshed.issues[0]?.summary).toBe("Original workspace ticket");
    const loaded = await backend.loadDetail("DEV-1");
    expect(loaded.description).toBe("Original workspace detail");
    backend.close();
  });

  test("does not attempt secure save when connect starts already aborted", async () => {
    const fixtureData = fixture();
    const controller = new AbortController();
    controller.abort();
    let saves = 0;
    const credentialStore = {
      async load() { return { kind: "ok", value: null } as CredentialResult<SavedCredentials | null>; },
      async save() { saves += 1; return { kind: "ok", value: true } as const; },
      async delete() { return { kind: "ok", value: true } as const; },
    } as unknown as SystemCredentialStore;
    const backend = new JiraDeskBackend({ cache: fixtureData.cache, credentials: credentialStore, env: fixtureData.env, jiraFactory: () => withTeamPort(fixtureData.jira) });

    await expect(backend.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "secret-token", cloudId: "cloud-123", remember: true }, controller.signal)).rejects.toMatchObject({ category: "cancelled", message: "Connection cancelled" });
    expect(saves).toBe(0);
    backend.close();
  });

  test("forgets a saved login through the credential store", async () => {
    const fixtureData = fixture();
    let deletes = 0;
    const credentialStore = {
      async load() { return { kind: "ok", value: null } as CredentialResult<SavedCredentials | null>; },
      async save() { return { kind: "ok", value: true } as const; },
      async delete() { deletes += 1; return { kind: "ok", value: true } as const; },
    } as unknown as SystemCredentialStore;
    const backend = new JiraDeskBackend({ cache: fixtureData.cache, credentials: credentialStore, env: fixtureData.env, jiraFactory: () => withTeamPort(fixtureData.jira) });

    await backend.forgetSavedLogin();
    expect(deletes).toBe(1);
    backend.close();
  });
});
