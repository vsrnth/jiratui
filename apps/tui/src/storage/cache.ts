import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type { IssueSummary } from "../domain";
import { ingestUpdateEvents, type UpdateEvent, type UpdateField, type UpdateLedger } from "../updates/ledger";

export const MAX_CACHED_ISSUES = 10_000;
export const SCHEMA_VERSION = 4;
export const DEFAULT_DATABASE_NAME = "jira-desk.sqlite3";

export type CacheIdentity = Readonly<{ siteId: string; accountId: string }>;

export type CachedWorkspaceState = Readonly<{
  issues: IssueSummary[];
  updates: UpdateLedger;
  baselineEstablished: boolean;
}>;

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
  db.run("PRAGMA busy_timeout = 5000");
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
  // These tables were added to schema v4. Keep this migration idempotent so a
  // database that already advertises v4 but predates the tables opens safely.
  db.run(`CREATE TABLE IF NOT EXISTS update_events (
    site_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    issue_id TEXT NOT NULL,
    issue_key TEXT NOT NULL,
    issue_summary TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    field TEXT NOT NULL,
    label TEXT NOT NULL,
    previous_value TEXT,
    current_value TEXT,
    PRIMARY KEY (site_id, account_id, event_id)
  )`);
  db.run("CREATE INDEX IF NOT EXISTS update_events_order ON update_events(site_id, account_id, occurred_at DESC, event_id ASC)");
  db.run(`CREATE TABLE IF NOT EXISTS update_issue_state (
    site_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    issue_id TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_expanded INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, account_id, issue_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS workspace_state (
    site_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    baseline_established INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, account_id)
  )`);
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
    return this.loadIssues(identity);
  }

  loadWorkspace(identityInput: CacheIdentity): CachedWorkspaceState {
    const identity = validateCacheIdentity(identityInput.siteId, identityInput.accountId);
    const issues = this.loadIssues(identity);
    const activeIds = issues.map((item) => item.id);
    const eventRows = this.db.query<StoredEventRow, [string, string]>(
      `SELECT event_id AS eventId, issue_id AS issueId, issue_key AS issueKey,
        issue_summary AS issueSummary, occurred_at AS occurredAt, field, label,
        previous_value AS previousValue, current_value AS currentValue
       FROM update_events WHERE site_id = ?1 AND account_id = ?2
       ORDER BY occurred_at DESC, event_id ASC`,
    ).all(identity.siteId, identity.accountId);
    const events = eventRows.flatMap((row) => {
      const event = storedEvent(row);
      return event && hasIssueId(activeIds, event.issueId) ? [event] : [];
    });
    const stateRows = this.db.query<StoredIssueStateRow, [string, string]>(
      "SELECT issue_id AS issueId, is_read AS isRead, is_expanded AS isExpanded FROM update_issue_state WHERE site_id = ?1 AND account_id = ?2",
    ).all(identity.siteId, identity.accountId);
    const readIssueIds = stateRows.filter((row) => row.isRead === 1 && hasIssueId(activeIds, row.issueId)).map((row) => row.issueId as IssueSummary["id"]);
    const expandedIssueIds = stateRows.filter((row) => row.isExpanded === 1 && hasIssueId(activeIds, row.issueId)).map((row) => row.issueId as IssueSummary["id"]);
    const updates = canonicalLedger({ events, readIssueIds, expandedIssueIds }, issues);
    const baseline = this.db.query<{ baselineEstablished?: number }, [string, string]>(
      "SELECT baseline_established AS baselineEstablished FROM workspace_state WHERE site_id = ?1 AND account_id = ?2",
    ).get(identity.siteId, identity.accountId);
    return { issues, updates, baselineEstablished: baseline?.baselineEstablished === 1 };
  }

  replace(identityInput: CacheIdentity, issues: readonly IssueSummary[]): void {
    const identity = validateCacheIdentity(identityInput.siteId, identityInput.accountId);
    const rows = issueRows(identity, issues);
    this.replaceIssues(identity, rows);
  }

  commitWorkspace(identityInput: CacheIdentity, issues: readonly IssueSummary[], updates: UpdateLedger, baselineEstablished: boolean): CachedWorkspaceState {
    const identity = validateCacheIdentity(identityInput.siteId, identityInput.accountId);
    if (typeof baselineEstablished !== "boolean") throw new StorageError("malformed", "Invalid workspace baseline state");
    validateIssueList(issues);
    const canonicalIssues = issues.map(issuePayload);
    const rows = issueRows(identity, canonicalIssues);
    const canonical = canonicalLedger(updates, canonicalIssues);
    const transaction = this.db.transaction(() => {
      this.deleteWorkspace(identity);
      this.insertIssueRows(rows);
      this.insertUpdateRows(identity, canonical);
      this.insertWorkspaceState(identity, canonical, baselineEstablished);
    });
    transaction();
    return { issues: canonicalIssues.slice(), updates: cloneLedger(canonical), baselineEstablished };
  }

  saveUpdateLedger(identityInput: CacheIdentity, ledger: UpdateLedger, activeIssues: readonly IssueSummary[]): UpdateLedger {
    const identity = validateCacheIdentity(identityInput.siteId, identityInput.accountId);
    // Validate snapshots before opening a destructive transaction. The active
    // set is authenticated membership, so the ledger is pruned to it here.
    validateIssueList(activeIssues);
    const canonical = canonicalLedger(ledger, activeIssues);
    const transaction = this.db.transaction(() => {
      this.db.run("DELETE FROM update_events WHERE site_id = ?1 AND account_id = ?2", [identity.siteId, identity.accountId]);
      this.db.run("DELETE FROM update_issue_state WHERE site_id = ?1 AND account_id = ?2", [identity.siteId, identity.accountId]);
      this.insertUpdateRows(identity, canonical);
      this.insertStateRows(identity, canonical);
    });
    transaction();
    return canonical;
  }

  private loadIssues(identity: CacheIdentity): IssueSummary[] {
    const rows = this.db.query<{ payload: string }, [string, string, number]>(
      "SELECT payload FROM issue_snapshots WHERE site_id = ?1 AND account_id = ?2 ORDER BY updated_at DESC, issue_key ASC LIMIT ?3",
    ).all(identity.siteId, identity.accountId, MAX_CACHED_ISSUES);
    return rows.flatMap((row) => {
      try { const value: unknown = JSON.parse(row.payload); return isIssueSummary(value) ? [value] : []; } catch { return []; }
    });
  }

  private replaceIssues(identity: CacheIdentity, rows: readonly IssueRow[]): void {
    const transaction = this.db.transaction(() => {
      this.db.run("DELETE FROM issue_snapshots WHERE site_id = ?1 AND account_id = ?2", [identity.siteId, identity.accountId]);
      this.insertIssueRows(rows);
    });
    transaction();
  }

  private deleteWorkspace(identity: CacheIdentity): void {
    this.db.run("DELETE FROM issue_snapshots WHERE site_id = ?1 AND account_id = ?2", [identity.siteId, identity.accountId]);
    this.db.run("DELETE FROM update_events WHERE site_id = ?1 AND account_id = ?2", [identity.siteId, identity.accountId]);
    this.db.run("DELETE FROM update_issue_state WHERE site_id = ?1 AND account_id = ?2", [identity.siteId, identity.accountId]);
    this.db.run("DELETE FROM workspace_state WHERE site_id = ?1 AND account_id = ?2", [identity.siteId, identity.accountId]);
  }

  private insertIssueRows(rows: readonly IssueRow[]): void {
    const insert = this.db.prepare("INSERT INTO issue_snapshots(site_id, account_id, issue_id, issue_key, updated_at, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)");
    for (const row of rows) insert.run(row.siteId, row.accountId, row.id, row.key, row.updated, row.payload);
  }

  private insertUpdateRows(identity: CacheIdentity, ledger: UpdateLedger): void {
    const insert = this.db.prepare(`INSERT INTO update_events
      (site_id, account_id, event_id, issue_id, issue_key, issue_summary, occurred_at, field, label, previous_value, current_value)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`);
    for (const event of ledger.events) insert.run(identity.siteId, identity.accountId, event.id, event.issueId, event.issueKey, event.issueSummary, event.occurredAt, event.field, event.label, event.previousValue, event.currentValue);
  }

  private insertStateRows(identity: CacheIdentity, ledger: UpdateLedger): void {
    const ids = new Set([...ledger.readIssueIds, ...ledger.expandedIssueIds].map(String));
    const read = new Set(ledger.readIssueIds.map(String));
    const expanded = new Set(ledger.expandedIssueIds.map(String));
    const insert = this.db.prepare("INSERT INTO update_issue_state(site_id, account_id, issue_id, is_read, is_expanded) VALUES (?1, ?2, ?3, ?4, ?5)");
    for (const issueId of ids) insert.run(identity.siteId, identity.accountId, issueId, read.has(issueId) ? 1 : 0, expanded.has(issueId) ? 1 : 0);
  }

  private insertWorkspaceState(identity: CacheIdentity, ledger: UpdateLedger, baselineEstablished: boolean): void {
    this.insertStateRows(identity, ledger);
    this.db.run("INSERT INTO workspace_state(site_id, account_id, baseline_established) VALUES (?1, ?2, ?3)", [identity.siteId, identity.accountId, baselineEstablished ? 1 : 0]);
  }
}

type IssueRow = Readonly<{ siteId: string; accountId: string; id: string; key: string; updated: string; payload: string }>;
type StoredEventRow = Readonly<{
  eventId: unknown;
  issueId: unknown;
  issueKey: unknown;
  issueSummary: unknown;
  occurredAt: unknown;
  field: unknown;
  label: unknown;
  previousValue: unknown;
  currentValue: unknown;
}>;
type StoredIssueStateRow = Readonly<{ issueId: unknown; isRead: unknown; isExpanded: unknown }>;

function validateIssueList(issues: readonly IssueSummary[]): void {
  if (!Array.isArray(issues)) throw new StorageError("malformed", "Invalid issue snapshot list");
  if (issues.length > MAX_CACHED_ISSUES) throw new StorageError("too_many_issues", "Cache snapshot exceeds 10000 issues");
  const ids = new Set<string>();
  for (const issue of issues) {
    if (!isIssueSummary(issue)) throw new StorageError("malformed", "Invalid issue snapshot");
    if (ids.has(String(issue.id))) throw new StorageError("malformed", "Duplicate issue snapshot");
    ids.add(String(issue.id));
  }
}

function issueRows(identity: CacheIdentity, issues: readonly IssueSummary[]): IssueRow[] {
  validateIssueList(issues);
  return issues.map((issue) => ({
    siteId: identity.siteId,
    accountId: identity.accountId,
    id: issue.id,
    key: issue.key,
    updated: issue.updated,
    payload: JSON.stringify(issuePayload(issue)),
  }));
}

function issuePayload(issue: IssueSummary): IssueSummary {
  // Persist only the renderer-neutral issue projection. In particular, do not
  // accidentally retain properties added by a Jira/renderer adapter.
  const output: IssueSummary = {
    id: issue.id,
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    statusCategory: issue.statusCategory,
    priority: issue.priority,
    assignee: issue.assignee,
    updated: issue.updated,
  };
  if (issue.created !== undefined) output.created = issue.created;
  if (issue.updatedAt !== undefined) output.updatedAt = issue.updatedAt;
  return output;
}

function canonicalLedger(ledger: UpdateLedger, activeIssues: readonly IssueSummary[]): UpdateLedger {
  if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.events) || !Array.isArray(ledger.readIssueIds) || !Array.isArray(ledger.expandedIssueIds)) {
    throw new StorageError("malformed", "Invalid update ledger");
  }
  for (const event of ledger.events) {
    if (!isUpdateEventShape(event)) throw new StorageError("malformed", "Invalid update event");
  }
  for (const issueId of [...ledger.readIssueIds, ...ledger.expandedIssueIds]) {
    if (typeof issueId !== "string" || issueId.length === 0) throw new StorageError("malformed", "Invalid update issue state");
  }
  try {
    return ingestUpdateEvents(ledger, [], activeIssues);
  } catch (error) {
    throw new StorageError("malformed", error instanceof Error ? error.message : "Invalid update ledger");
  }
}

function cloneLedger(ledger: UpdateLedger): UpdateLedger {
  return {
    events: ledger.events.map((event) => ({ ...event })),
    readIssueIds: ledger.readIssueIds.slice(),
    expandedIssueIds: ledger.expandedIssueIds.slice(),
  };
}

function isUpdateEventShape(value: unknown): value is UpdateEvent {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && item.id.length > 0 &&
    typeof item.issueId === "string" && item.issueId.length > 0 &&
    typeof item.issueKey === "string" && /^[A-Z0-9_]+-[0-9]+$/u.test(item.issueKey) &&
    typeof item.issueSummary === "string" && typeof item.occurredAt === "string" &&
    isUpdateField(item.field) && typeof item.label === "string" &&
    (item.previousValue === null || typeof item.previousValue === "string") &&
    (item.currentValue === null || typeof item.currentValue === "string");
}

function isUpdateField(value: unknown): value is UpdateField {
  return value === "summary" || value === "status" || value === "priority" || value === "assignee" || value === "other";
}

function storedEvent(row: StoredEventRow): UpdateEvent | null {
  if (!isUpdateEventShape({
    id: row.eventId,
    issueId: row.issueId,
    issueKey: row.issueKey,
    issueSummary: row.issueSummary,
    occurredAt: row.occurredAt,
    field: row.field,
    label: row.label,
    previousValue: row.previousValue,
    currentValue: row.currentValue,
  })) return null;
  if (!isSafeText(row.eventId, 72) || !isSafeText(row.issueId, 255) || !isSafeText(row.issueSummary, 512) || !isSafeText(row.occurredAt, 64) || !isSafeText(row.label, 512) ||
      (row.previousValue !== null && !isSafeText(row.previousValue, 512)) || (row.currentValue !== null && !isSafeText(row.currentValue, 512))) return null;
  return {
    id: row.eventId as string,
    issueId: row.issueId as IssueSummary["id"],
    issueKey: row.issueKey as IssueSummary["key"],
    issueSummary: row.issueSummary as string,
    occurredAt: row.occurredAt as string,
    field: row.field as UpdateField,
    label: row.label as string,
    previousValue: row.previousValue as string | null,
    currentValue: row.currentValue as string | null,
  };
}

function hasIssueId(activeIds: readonly IssueSummary["id"][], issueId: unknown): boolean {
  return typeof issueId === "string" && activeIds.some((id) => String(id) === issueId);
}

function isIssueSummary(value: unknown): value is IssueSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return isBoundedText(item.id, 255) && typeof item.key === "string" && item.key.length <= 255 && /^[A-Z0-9_]+-[0-9]+$/u.test(item.key) &&
    isBoundedText(item.summary, 16_384) && isBoundedText(item.status, 512) && isStatusCategory(item.statusCategory) &&
    isBoundedText(item.priority, 512) && isBoundedText(item.assignee, 512) && isBoundedText(item.updated, 128) &&
    (item.created === undefined || isBoundedText(item.created, 128)) && (item.updatedAt === undefined || isBoundedText(item.updatedAt, 128));
}

function isStatusCategory(value: unknown): value is IssueSummary["statusCategory"] {
  return value === "to_do" || value === "in_progress" || value === "done" || value === "uncategorized";
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && ![...value].some((char) => /[\u0000-\u001f\u007f]/u.test(char));
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength && ![...value].some((char) => /[\u0000-\u001f\u007f]/u.test(char));
}

export function listDirectoryEntries(path: string): string[] {
  return readdirSync(path);
}
