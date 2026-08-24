import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDirectory, IssueCache, MAX_CACHED_ISSUES, scopePartitionSiteId, StorageError, validateCacheIdentity } from "../src/storage/cache";
import { SystemCredentialStore, type SecretProvider } from "../src/storage/credentials";
import type { IssueSummary } from "../src/domain";
import { applyUpdateSnapshot, emptyUpdateLedger, markGroupsRead, setGroupExpanded, type UpdateEvent } from "../src/updates/ledger";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) if (existsSync(path)) rmSync(path, { recursive: true, force: true }); });
const issue = (n: number): IssueSummary => ({ id: String(n) as IssueSummary["id"], key: `DEV-${n}` as IssueSummary["key"], summary: `Issue ${n}`, status: "Open", statusCategory: "to_do", priority: "Medium", assignee: "A user", updated: `2026-01-${String(n % 28 + 1).padStart(2, "0")}` });
const cacheAt = () => { const dir = `/tmp/jira-desk-storage-${crypto.randomUUID()}`; mkdirSync(dir, { recursive: true }); temporary.push(dir); return new IssueCache(join(dir, "jira-desk.sqlite3")); };

describe("IssueCache", () => {
  test("replaces atomically by site and account and loads newest first", () => {
    const cache = cacheAt();
    const first = validateCacheIdentity("site-a", "account-a");
    const second = validateCacheIdentity("site-a", "account-b");
    cache.replace(first, [issue(1), issue(2)]);
    cache.replace(second, [issue(3)]);
    expect(cache.load(first).map((item) => item.key as string)).toEqual(["DEV-2", "DEV-1"]);
    expect(cache.load(second).map((item) => item.key as string)).toEqual(["DEV-3"]);
    cache.close();
  });

  test("rejects snapshots over the bounded cache size", () => {
    const cache = cacheAt();
    const values = Array.from({ length: MAX_CACHED_ISSUES + 1 }, (_, index) => issue(index + 1));
    expect(() => cache.replace(validateCacheIdentity("site", "account"), values)).toThrow(StorageError);
    cache.close();
  });

  test("round-trips the workspace ledger, local state, and baseline by partition", () => {
    const cache = cacheAt();
    const first = validateCacheIdentity("site-roundtrip", "account-a");
    const second = validateCacheIdentity("site-roundtrip", "account-b");
    const previous = issue(1);
    const current = { ...previous, summary: "Changed", updated: "2026-02-01" };
    let ledger = applyUpdateSnapshot(emptyUpdateLedger(), [previous], [current]);
    ledger = markGroupsRead(ledger, [current.id], true, [current.id]);
    ledger = setGroupExpanded(ledger, current.id, true);
    const committed = cache.commitWorkspace(first, [current], ledger, true);
    expect(committed).toEqual({ issues: [current], updates: ledger, baselineEstablished: true });
    expect(committed.issues).not.toBe(current);
    expect(committed.updates).not.toBe(ledger);
    cache.commitWorkspace(second, [issue(2)], emptyUpdateLedger(), false);
    expect(cache.loadWorkspace(first)).toMatchObject({ issues: [current], baselineEstablished: true });
    expect(cache.loadWorkspace(first).updates).toEqual(ledger);
    expect(cache.loadWorkspace(second).updates).toEqual(emptyUpdateLedger());
    cache.close();
  });

  test("saveUpdateLedger prunes membership and enforces the 500-event bound", () => {
    const cache = cacheAt();
    const identity = validateCacheIdentity("site-ledger", "account-a");
    const active = issue(1);
    const inactive = issue(2);
    const events: UpdateEvent[] = Array.from({ length: 501 }, (_, index) => ({
      id: `event-${index}`,
      issueId: active.id,
      issueKey: active.key,
      issueSummary: active.summary,
      occurredAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      field: "other",
      label: "Other Jira activity · exact field not available from sync",
      previousValue: null,
      currentValue: null,
    }));
    const saved = cache.saveUpdateLedger(identity, {
      events: [...events, { ...events[0]!, issueId: inactive.id, issueKey: inactive.key }],
      readIssueIds: [active.id, inactive.id],
      expandedIssueIds: [active.id, inactive.id],
    }, [active]);
    expect(saved.events).toHaveLength(500);
    expect(saved.events.every((event) => event.issueId === active.id)).toBe(true);
    expect(saved.readIssueIds).toEqual([active.id]);
    expect(saved.expandedIssueIds).toEqual([active.id]);
    cache.close();
  });

  test("creates missing v4 ledger tables for an existing v4 database", () => {
    const dir = `/tmp/jira-desk-storage-legacy-${crypto.randomUUID()}`;
    mkdirSync(dir, { recursive: true }); temporary.push(dir);
    const path = join(dir, "jira-desk.sqlite3");
    const legacy = new Database(path, { create: true });
    legacy.run("PRAGMA user_version = 4");
    legacy.close();
    const cache = new IssueCache(path);
    cache.commitWorkspace(validateCacheIdentity("site", "account"), [issue(1)], emptyUpdateLedger(), false);
    expect(cache.loadWorkspace(validateCacheIdentity("site", "account")).issues).toHaveLength(1);
    cache.close();
  });

  test("keeps the prior workspace when a malformed commit is rejected before mutation", () => {
    const cache = cacheAt();
    const identity = validateCacheIdentity("site-atomic", "account-a");
    const original = issue(1);
    const ledger = applyUpdateSnapshot(emptyUpdateLedger(), [original], [{ ...original, summary: "Changed", updated: "2026-02-01" }]);
    cache.commitWorkspace(identity, [original], ledger, true);
    const malformed = { ...original, key: "invalid" as IssueSummary["key"] };
    expect(() => cache.commitWorkspace(identity, [malformed], emptyUpdateLedger(), false)).toThrow(StorageError);
    const restored = cache.loadWorkspace(identity);
    expect(restored.issues).toEqual([original]);
    expect(restored.updates).toEqual(ledger);
    expect(restored.baselineEstablished).toBe(true);
    cache.close();
  });

  test("rolls back all workspace tables when an insert fails inside the transaction", () => {
    const dir = `/tmp/jira-desk-storage-transaction-${crypto.randomUUID()}`;
    mkdirSync(dir, { recursive: true }); temporary.push(dir);
    const path = join(dir, "jira-desk.sqlite3");
    const cache = new IssueCache(path);
    const identity = validateCacheIdentity("site-transaction", "account-a");
    const original = issue(1);
    const originalLedger = applyUpdateSnapshot(emptyUpdateLedger(), [original], [{ ...original, summary: "Changed", updated: "2026-02-01" }]);
    cache.commitWorkspace(identity, [original], originalLedger, true);

    const triggerDb = new Database(path, { create: true });
    triggerDb.run(`CREATE TRIGGER fail_update_insert BEFORE INSERT ON update_events
      WHEN NEW.event_id = 'boom'
      BEGIN SELECT RAISE(ABORT, 'deliberate test failure'); END`);
    triggerDb.close();
    const failingIssue = { ...original, id: "2" as IssueSummary["id"], key: "DEV-2" as IssueSummary["key"] };
    const failingLedger = {
      events: [{
        id: "boom",
        issueId: failingIssue.id,
        issueKey: failingIssue.key,
        issueSummary: failingIssue.summary,
        occurredAt: "2026-03-01T00:00:00.000Z",
        field: "other" as const,
        label: "Other Jira activity · exact field not available from sync",
        previousValue: null,
        currentValue: null,
      }],
      readIssueIds: [failingIssue.id],
      expandedIssueIds: [failingIssue.id],
    };
    expect(() => cache.commitWorkspace(identity, [failingIssue], failingLedger, false)).toThrow();
    const dropTriggerDb = new Database(path, { create: true });
    dropTriggerDb.run("DROP TRIGGER fail_update_insert");
    dropTriggerDb.close();

    const restored = cache.loadWorkspace(identity);
    expect(restored.issues).toEqual([original]);
    expect(restored.updates).toEqual(originalLedger);
    expect(restored.baselineEstablished).toBe(true);
    cache.close();
  });

  test("rejects symlinked database paths", () => {
    const dir = `/tmp/jira-desk-storage-link-${crypto.randomUUID()}`;
    const real = `/tmp/jira-desk-storage-real-${crypto.randomUUID()}`;
    mkdirSync(real, { recursive: true }); symlinkSync(real, dir); temporary.push(real, dir);
    expect(() => new IssueCache(join(dir, "jira-desk.sqlite3"))).toThrow(StorageError);
  });

  test("protects only the application directory, not an existing XDG parent", () => {
    const root = `/tmp/jira-desk-storage-parent-${crypto.randomUUID()}`;
    mkdirSync(root, { recursive: true, mode: 0o755 });
    chmodSync(root, 0o755);
    temporary.push(root);

    const directory = ensureDataDirectory({ XDG_DATA_HOME: root });
    expect(statSync(root).mode & 0o777).toBe(0o755);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  test("rejects a symlink at the application directory", () => {
    const root = `/tmp/jira-desk-storage-app-link-${crypto.randomUUID()}`;
    const real = `/tmp/jira-desk-storage-app-real-${crypto.randomUUID()}`;
    mkdirSync(root, { recursive: true });
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(root, "jira-desk"));
    temporary.push(root, real);

    expect(() => ensureDataDirectory({ XDG_DATA_HOME: root })).toThrow(StorageError);
  });
});

describe("scopePartitionSiteId", () => {
  test("preserves the validated site identity for an omitted or blank scope", () => {
    expect(scopePartitionSiteId("  site-a  ")).toBe("site-a");
    expect(scopePartitionSiteId("  site-a  ", undefined)).toBe("site-a");
    expect(scopePartitionSiteId("  site-a  ", "   ")).toBe("site-a");
  });

  test("normalizes scope whitespace and separates sites and scopes", () => {
    const first = scopePartitionSiteId("site-a", "  project = DEV  ");
    expect(first).toBe(scopePartitionSiteId("site-a", "project = DEV"));
    expect(first).not.toBe(scopePartitionSiteId("site-a", "project = OPS"));
    expect(first).not.toBe(scopePartitionSiteId("site-b", "project = DEV"));
  });

  test("returns a bounded opaque identity without raw site or JQL text", () => {
    const site = "tenant.example.test";
    const scope = "project = DEV AND summary ~ \"needle/with spaces\"";
    const partition = scopePartitionSiteId(site, scope);
    expect(partition).toMatch(/^scope-v1:[0-9a-f]{64}$/);
    expect(partition.length).toBeLessThanOrEqual(320);
    expect(partition).not.toContain(site);
    expect(partition).not.toContain(scope);
    expect([...partition].some((char) => /\p{Cc}/u.test(char))).toBe(false);
    expect(partition).not.toMatch(/[\\/]/u);
  });

  test("rejects an unsafe base site identity", () => {
    expect(() => scopePartitionSiteId("site-\u0000-a", "project = DEV")).toThrow(StorageError);
    expect(() => scopePartitionSiteId("x".repeat(321), "project = DEV")).toThrow(StorageError);
  });
});

describe("SystemCredentialStore", () => {
  test("stores only in the native provider and restores the versioned saved login", async () => {
    const calls: Array<{ operation: string; options: Record<string, unknown> }> = [];
    let payload = "";
    const provider: SecretProvider = {
      async set(options) { calls.push({ operation: "set", options }); payload = options.value; },
      async get(options) { calls.push({ operation: "get", options }); return payload || null; },
      async delete(options) { calls.push({ operation: "delete", options }); payload = ""; return true; },
    };
    const store = new SystemCredentialStore(provider);
    const token = "secret-api-token";
    await expect(store.save({
      baseUrl: "https://example.atlassian.net",
      email: "ada@example.test",
      token,
      cloudId: "cloud-123",
      siteId: "example.atlassian.net",
    })).resolves.toEqual({ kind: "ok", value: true });
    expect(calls[0]?.operation).toBe("set");
    expect(calls[0]?.options.allowUnrestrictedAccess).toBe(false);
    expect(calls[0]?.options.service).toBe("dev.jiradesk.JiraDesk");
    expect(JSON.stringify({ service: calls[0]?.options.service, name: calls[0]?.options.name })).not.toContain(token);
    expect(JSON.parse(payload).version).toBe(1);

    const loaded = await store.load();
    expect(loaded.kind).toBe("ok");
    if (loaded.kind !== "ok" || !loaded.value) throw new Error("saved login was not restored");
    expect(loaded.value.toString()).toBe("[SavedCredentials redacted]");
    expect(() => JSON.stringify(loaded.value)).toThrow("Credentials cannot be serialized");
    expect(loaded.value.intoParts()).toEqual({
      baseUrl: "https://example.atlassian.net",
      email: "ada@example.test",
      token,
      cloudId: "cloud-123",
      siteId: "example.atlassian.net",
    });
  });

  test("does not substitute plaintext storage when native secrets are unavailable", async () => {
    const unavailable: SecretProvider = {
      async get() { throw new Error("unavailable"); },
      async set() { throw new Error("unavailable"); },
      async delete() { throw new Error("unavailable"); },
    };
    const store = new SystemCredentialStore(unavailable);
    await expect(store.save({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token: "token" }))
      .resolves.toEqual({ kind: "unavailable", message: "Secure credential storage is unavailable" });
  });

  test("deletes saved login and keeps credential objects redacted", async () => {
    let payload: string | null = null;
    const token = "secret-delete-token";
    const provider: SecretProvider = {
      async get() { return payload; },
      async set(options) { payload = options.value; },
      async delete() { payload = null; return true; },
    };
    const store = new SystemCredentialStore(provider);
    await expect(store.save({ baseUrl: "https://example.atlassian.net", email: "ada@example.test", token }))
      .resolves.toEqual({ kind: "ok", value: true });

    const loaded = await store.load();
    if (loaded.kind !== "ok" || !loaded.value) throw new Error("saved login was not loaded");
    expect(String(loaded.value)).not.toContain(token);
    expect(() => JSON.stringify({ saved: loaded.value })).toThrow("Credentials cannot be serialized");

    await expect(store.delete()).resolves.toEqual({ kind: "ok", value: true });
    await expect(store.load()).resolves.toEqual({ kind: "ok", value: null });
    expect(payload).toBeNull();
  });
});
