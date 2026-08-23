import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDirectory, IssueCache, MAX_CACHED_ISSUES, StorageError, validateCacheIdentity } from "../src/storage/cache";
import { SystemCredentialStore, type SecretProvider } from "../src/storage/credentials";
import type { IssueSummary } from "../src/domain";

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
