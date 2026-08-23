import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type { IssueSummary } from "../domain";

export const MAX_CACHED_ISSUES = 10_000;
export const SCHEMA_VERSION = 4;
export const DEFAULT_DATABASE_NAME = "jira-desk.sqlite3";

export type CacheIdentity = Readonly<{ siteId: string; accountId: string }>;

export class StorageError extends Error {
  readonly code: "unsafe_path" | "invalid_identity" | "too_many_issues" | "database" | "malformed";
  constructor(code: StorageError["code"], message: string) { super(message); this.name = "StorageError"; this.code = code; }
}

export function validateCacheIdentity(siteId: string, accountId: string): CacheIdentity {
  const valid = (value: string) => value.trim().length > 0 && value.length <= 320 && ![...value].some((char) => /\p{Cc}/u.test(char));
  if (!valid(siteId) || !valid(accountId)) throw new StorageError("invalid_identity", "Invalid cache identity");
  return { siteId: siteId.trim(), accountId: accountId.trim() };
}

/** Resolve the app directory without ever accepting a relative root. */
export function resolveDataDirectory(env: Record<string, string | undefined> = process.env): string {
  const root = env.XDG_DATA_HOME?.trim() || (env.HOME ? join(env.HOME, ".local", "share") : "");
  if (!root || !isAbsolute(root)) throw new StorageError("unsafe_path", "XDG data root must be absolute");
  return join(root, "jira-desk");
}

function rejectSymlinkComponents(path: string): void {
  // The app/state directory itself must not be a symlink. System temp roots
  // such as macOS's /tmp alias are intentionally allowed as trusted parents.
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new StorageError("unsafe_path", "Symlink in cache path");
}

function ensureDirectory(path: string): void {
  if (!isAbsolute(path)) throw new StorageError("unsafe_path", "Cache directory must be absolute");
  rejectSymlinkComponents(path);
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory()) throw new StorageError("unsafe_path", "Cache path is not a directory");
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  try { chmodSync(path, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
}

function ensureParentDirectory(path: string): void {
  if (!isAbsolute(path)) throw new StorageError("unsafe_path", "Cache directory must be absolute");
  rejectSymlinkComponents(path);
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory()) throw new StorageError("unsafe_path", "Cache path is not a directory");
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function ensureDataDirectory(env: Record<string, string | undefined> = process.env): string {
  const directory = resolveDataDirectory(env);
  ensureParentDirectory(dirname(directory));
  ensureDirectory(directory);
  return directory;
}

function validateDatabasePath(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || path.endsWith(`${process.platform === "win32" ? "\\" : "/"}`)) throw new StorageError("unsafe_path", "Database path must be absolute");
  rejectSymlinkComponents(dirname(path));
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new StorageError("unsafe_path", "Database cannot be a symlink");
}

function migrate(db: Database): void {
  const version = Number((db.query("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0);
  if (version > SCHEMA_VERSION) throw new StorageError("database", "Unsupported cache schema");
  db.run(`CREATE TABLE IF NOT EXISTS issue_snapshots (
    site_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    issue_id TEXT NOT NULL,
    issue_key TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (site_id, account_id, issue_id)
  )`);
  db.run("CREATE INDEX IF NOT EXISTS issue_snapshots_order ON issue_snapshots(site_id, account_id, updated_at DESC, issue_key ASC)");
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export class IssueCache {
  readonly path: string;
  private readonly db: Database;

  constructor(path: string) {
    validateDatabasePath(path);
    ensureDirectory(dirname(path));
    this.path = path;
    try { this.db = new Database(path, { create: true }); migrate(this.db); } catch (error) {
      throw new StorageError("database", error instanceof Error ? error.message : "Unable to open cache");
    }
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
  }

  static openDefault(env: Record<string, string | undefined> = process.env): IssueCache {
    return new IssueCache(join(ensureDataDirectory(env), DEFAULT_DATABASE_NAME));
  }

  close(): void { this.db.close(); }

  load(identityInput: CacheIdentity): IssueSummary[] {
    const identity = validateCacheIdentity(identityInput.siteId, identityInput.accountId);
    const rows = this.db.query<{ payload: string }, [string, string, number]>(
      "SELECT payload FROM issue_snapshots WHERE site_id = ?1 AND account_id = ?2 ORDER BY updated_at DESC, issue_key ASC LIMIT ?3",
    ).all(identity.siteId, identity.accountId, MAX_CACHED_ISSUES);
    return rows.flatMap((row) => {
      try { const value: unknown = JSON.parse(row.payload); return isIssueSummary(value) ? [value] : []; } catch { return []; }
    });
  }

  replace(identityInput: CacheIdentity, issues: readonly IssueSummary[]): void {
    if (issues.length > MAX_CACHED_ISSUES) throw new StorageError("too_many_issues", "Cache snapshot exceeds 10000 issues");
    const identity = validateCacheIdentity(identityInput.siteId, identityInput.accountId);
    const rows = issues.map((issue) => {
      if (!isIssueSummary(issue)) throw new StorageError("malformed", "Invalid issue snapshot");
      return [identity.siteId, identity.accountId, issue.id, issue.key, issue.updated, JSON.stringify(issue)] as const;
    });
    const transaction = this.db.transaction((items: readonly (readonly [string, string, string, string, string, string])[]) => {
      this.db.run("DELETE FROM issue_snapshots WHERE site_id = ?1 AND account_id = ?2", [identity.siteId, identity.accountId]);
      const insert = this.db.prepare("INSERT INTO issue_snapshots(site_id, account_id, issue_id, issue_key, updated_at, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)");
      for (const row of items) insert.run(row[0], row[1], row[2], row[3], row[4], row[5]);
    });
    transaction(rows);
  }
}

function isIssueSummary(value: unknown): value is IssueSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && item.id.length > 0 && typeof item.key === "string" && /^[A-Z0-9_]+-[0-9]+$/u.test(item.key) &&
    typeof item.summary === "string" && typeof item.status === "string" && typeof item.statusCategory === "string" &&
    typeof item.priority === "string" && typeof item.assignee === "string" && typeof item.updated === "string";
}

export function listDirectoryEntries(path: string): string[] {
  return readdirSync(path);
}
