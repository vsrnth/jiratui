import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { IssueCache } from "../src/storage/cache";
import { JiraDeskBackend, Workspace } from "../src/backend";
import { SystemCredentialStore, type CredentialResult, type SavedCredentials, type SecretProvider } from "../src/storage/credentials";
import type { IssueDetail, IssueSummary } from "../src/domain";
import { emptyUpdateLedger, markGroupsRead } from "../src/updates/ledger";
import { PreferencesStore } from "../src/storage/preferences";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const summary: IssueSummary = { id: "1" as IssueSummary["id"], key: "DEV-1" as IssueSummary["key"], summary: "A ticket", status: "Open", statusCategory: "to_do", priority: "Medium", assignee: "Unassigned", updated: "2026-01-01" };
const detail: IssueDetail = { issue: summary, issueType: "Task", reporter: "Ada", project: "DEV", parent: null, labels: [], dueDate: null, created: "2026-01-01", description: "Description", comments: [], attachments: [], remote: true };

function fixture() {
  const dir = `/tmp/jira-desk-backend-${crypto.randomUUID()}`; dirs.push(dir); mkdirSync(dir, { recursive: true });
  let searches = 0;
  const jira = { async myself() { return { accountId: "acct-1", displayName: "Ada" }; }, async searchAssignedOrWatched() { searches += 1; return [summary]; }, async issueDetail() { return detail; } };
  return { jira, cache: new IssueCache(join(dir, "jira-desk.sqlite3")), get searches() { return searches; } };
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
    const backend = new JiraDeskBackend({ env, cache: fixtureData.cache, preferences: new PreferencesStore(env), jiraFactory: () => fixtureData.jira });
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
    const backend = new JiraDeskBackend({ cache: fixtureData.cache, credentials: credentialStore, jiraFactory: () => fixtureData.jira });
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
      jiraFactory: () => jira,
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
      jiraFactory: () => jira,
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
    const first = new JiraDeskBackend({ cache: new IssueCache(databasePath), credentials, jiraFactory: () => jira });
    await first.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "secret-token", cloudId: "cloud-123", remember: false });
    current = { ...summary, summary: "Changed", updated: "2026-02-01" };
    const changed = await first.refresh();
    const read = markGroupsRead(changed.updates, [summary.id], true, [summary.id]);
    first.persistUpdateLedger(read);
    first.close();

    const second = new JiraDeskBackend({ cache: new IssueCache(databasePath), credentials, jiraFactory: () => jira });
    const restored = await second.connect({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "secret-token", cloudId: "cloud-123", remember: false });
    expect(restored.source).toBe("cache");
    expect(restored.updates.events).toHaveLength(1);
    expect(restored.updates.readIssueIds).toEqual([summary.id]);
    second.close();
  });

  test("requires authentication to persist local updates", () => {
    const fixtureData = fixture();
    const backend = new JiraDeskBackend({ cache: fixtureData.cache, jiraFactory: () => fixtureData.jira });
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
      jiraFactory: () => fixtureData.jira,
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
    const backend = new JiraDeskBackend({ cache: fixtureData.cache, credentials: credentialStore, jiraFactory: () => jira });

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
      jiraFactory: (_baseUrl, _email, token) => token === "old-token" ? originalJira : replacementJira,
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
    const backend = new JiraDeskBackend({ cache: fixtureData.cache, credentials: credentialStore, jiraFactory: () => fixtureData.jira });

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
    const backend = new JiraDeskBackend({ cache: fixtureData.cache, credentials: credentialStore, jiraFactory: () => fixtureData.jira });

    await backend.forgetSavedLogin();
    expect(deletes).toBe(1);
    backend.close();
  });
});
