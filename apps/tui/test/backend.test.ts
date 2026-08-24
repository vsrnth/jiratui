import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { IssueCache } from "../src/storage/cache";
import { JiraDeskBackend, Workspace } from "../src/backend";
import { SystemCredentialStore, type CredentialResult, type SavedCredentials, type SecretProvider } from "../src/storage/credentials";
import type { IssueDetail, IssueSummary } from "../src/domain";

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
});

describe("JiraDeskBackend", () => {
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
