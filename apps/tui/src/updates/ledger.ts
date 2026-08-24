import type { IssueId, IssueKey, IssueSummary } from "../domain";

/** Maximum number of local feed rows retained by one workspace. */
export const MAX_UPDATE_EVENTS = 500;
/** Maximum number of rows shown before a group is expanded. */
export const DEFAULT_UPDATE_ROW_LIMIT = 3;
export const GENERIC_UPDATE_LABEL = "Other Jira activity · exact field not available from sync";

export type UpdateField = "summary" | "status" | "priority" | "assignee" | "other";
export type UpdateFilter = "all" | "unread";

/** A bounded, renderer-neutral row in the local update ledger. */
export type UpdateEvent = Readonly<{
  id: string;
  issueId: IssueId;
  issueKey: IssueKey;
  issueSummary: string;
  occurredAt: string;
  field: UpdateField;
  label: string;
  previousValue: string | null;
  currentValue: string | null;
}>;

export type UpdateLedger = Readonly<{
  events: readonly UpdateEvent[];
  readIssueIds: readonly IssueId[];
  expandedIssueIds: readonly IssueId[];
}>;

export type UpdateGroup = Readonly<{
  issueId: IssueId;
  issueKey: IssueKey;
  issueSummary: string;
  latestAt: string;
  unread: boolean;
  expanded: boolean;
  events: readonly UpdateEvent[];
  rows: readonly UpdateEvent[];
}>;

export class UpdateLedgerValidationError extends Error {
  readonly code = "invalid_update_ledger_input" as const;

  constructor(message: string) {
    super(message);
    this.name = "UpdateLedgerValidationError";
  }
}

const FIELD_ORDER: readonly UpdateField[] = ["summary", "status", "priority", "assignee", "other"];
const FIELD_LABELS: Readonly<Record<UpdateField, string>> = {
  summary: "Summary changed",
  status: "Status changed",
  priority: "Priority changed",
  assignee: "Assignee changed",
  other: GENERIC_UPDATE_LABEL,
};
const MAX_EVENT_TEXT = 512;
const MAX_TIMESTAMP = 64;
const MAX_EVENT_ID = 72;

type Snapshot = Pick<IssueSummary, "id" | "key" | "summary" | "status" | "priority" | "assignee" | "updated">;

function boundedText(value: unknown, maxChars = MAX_EVENT_TEXT): string {
  if (typeof value !== "string") return "";
  return [...value]
    .filter((char) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(char))
    .slice(0, maxChars)
    .join("")
    .trim();
}

function boundedTimestamp(value: unknown): string {
  const text = boundedText(value, MAX_TIMESTAMP);
  const millis = Date.parse(text);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : text;
}

function compareEvents(a: UpdateEvent, b: UpdateEvent): number {
  const time = b.occurredAt.localeCompare(a.occurredAt);
  if (time !== 0) return time;
  const issue = String(a.issueId).localeCompare(String(b.issueId));
  if (issue !== 0) return issue;
  const field = FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field);
  if (field !== 0) return field;
  return a.id.localeCompare(b.id);
}

function compareIds(a: IssueId, b: IssueId): number {
  return String(a).localeCompare(String(b));
}

function hashPart(value: string): string {
  // FNV-1a gives a short deterministic identifier without putting summary/body text in the ID.
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function eventId(issue: Snapshot, timestamp: string, field: UpdateField, previous: string | null, current: string | null): string {
  const seed = [String(issue.id), timestamp, field, previous ?? "", current ?? ""].join("\u001f");
  // The event ID is intentionally only hashes and fixed labels; raw unbounded Jira text never appears in it.
  return `u-${hashPart(seed)}-${hashPart(`${seed.length}:${seed.slice(0, 128)}`)}`.slice(0, MAX_EVENT_ID);
}

function activeSet(activeIssueIds: readonly IssueId[]): Set<string> {
  return new Set(activeIssueIds.map((id) => String(id)));
}

function normalizeEvent(event: UpdateEvent): UpdateEvent {
  return {
    id: boundedText(event.id, MAX_EVENT_ID),
    issueId: event.issueId,
    issueKey: event.issueKey,
    issueSummary: boundedText(event.issueSummary),
    occurredAt: boundedTimestamp(event.occurredAt),
    field: event.field,
    label: boundedText(event.label, MAX_EVENT_TEXT),
    previousValue: event.previousValue === null ? null : boundedText(event.previousValue),
    currentValue: event.currentValue === null ? null : boundedText(event.currentValue),
  };
}

function retainEvents(events: readonly UpdateEvent[], activeIssueIds: readonly IssueId[]): UpdateEvent[] {
  const allowed = activeSet(activeIssueIds);
  const byId = new Map<string, UpdateEvent>();
  for (const input of events) {
    if (!allowed.has(String(input.issueId))) continue;
    const value = normalizeEvent(input);
    if (!value.id) continue;
    byId.set(value.id, value);
  }
  return [...byId.values()].sort(compareEvents).slice(0, MAX_UPDATE_EVENTS);
}

/** An empty local ledger. Read and expansion state are local and never sent to Jira. */
export function emptyUpdateLedger(): UpdateLedger {
  return { events: [], readIssueIds: [], expandedIssueIds: [] };
}

/**
 * Derive local events from two authenticated-view snapshots.
 * Pass `null` for `previous` (or `{ baseline: true }`) for the quiet first baseline.
 */
export function deriveUpdateEvents(
  previous: readonly IssueSummary[] | null,
  current: readonly IssueSummary[],
  options: { baseline?: boolean } = {},
): UpdateEvent[] {
  if (options.baseline === true || previous === null) return [];

  const previousById = new Map(previous.map((issue) => [String(issue.id), issue as Snapshot]));
  const output: UpdateEvent[] = [];
  for (const issue of current) {
    const snapshot = issue as Snapshot;
    const old = previousById.get(String(issue.id));
    const timestamp = boundedTimestamp(issue.updated);
    if (!old) {
      // A newly visible issue has no trustworthy field diff; retain one honest generic row.
      output.push(makeEvent(snapshot, timestamp, "other", null, null));
      continue;
    }

    const changed: Array<[UpdateField, string, string]> = [
      ["summary", old.summary, issue.summary],
      ["status", old.status, issue.status],
      ["priority", old.priority, issue.priority],
      ["assignee", old.assignee, issue.assignee],
    ];
    let changedKnownField = false;
    for (const [field, before, after] of changed) {
      const oldValue = boundedText(before);
      const newValue = boundedText(after);
      if (oldValue === newValue) continue;
      changedKnownField = true;
      output.push(makeEvent(snapshot, timestamp, field, oldValue, newValue));
    }
    if (!changedKnownField && boundedTimestamp(old.updated) !== timestamp) {
      output.push(makeEvent(snapshot, timestamp, "other", null, null));
    }
  }
  return output.sort(compareEvents).slice(0, MAX_UPDATE_EVENTS);
}

function makeEvent(issue: Snapshot, occurredAt: string, field: UpdateField, previousValue: string | null, currentValue: string | null): UpdateEvent {
  return normalizeEvent({
    id: eventId(issue, occurredAt, field, previousValue, currentValue),
    issueId: issue.id,
    issueKey: issue.key,
    issueSummary: boundedText(issue.summary),
    occurredAt,
    field,
    label: FIELD_LABELS[field],
    previousValue,
    currentValue,
  });
}

/** Merge a sync result into the bounded local ledger and remove issues outside the current view. */
export function ingestUpdateEvents(
  ledger: UpdateLedger,
  incoming: readonly UpdateEvent[],
  activeIssues: readonly IssueSummary[] | readonly IssueId[],
): UpdateLedger {
  const activeIds = activeIssues.map((issue) => typeof issue === "string" ? issue : issue.id) as IssueId[];
  const allowed = activeSet(activeIds);
  // Normalize before comparing IDs. This makes overlap/reconciliation replays idempotent while
  // ensuring a genuinely new event for a previously read group is visible as unread.
  const normalizedIncoming = incoming
    .map(normalizeEvent)
    .filter((event) => event.id.length > 0 && allowed.has(String(event.issueId)));
  const retainedIds = new Set(ledger.events.map((event) => normalizeEvent(event).id));
  const newIssueIds = new Set(
    normalizedIncoming
      .filter((event) => !retainedIds.has(event.id))
      .map((event) => String(event.issueId)),
  );
  const events = retainEvents([...ledger.events, ...normalizedIncoming], activeIds);
  const readIssueIds = ledger.readIssueIds
    .filter((id) => allowed.has(String(id)) && !newIssueIds.has(String(id)));
  return {
    events,
    readIssueIds,
    expandedIssueIds: ledger.expandedIssueIds.filter((id) => allowed.has(String(id))),
  };
}

/** Apply one snapshot pair and enforce current authenticated-view membership. */
export function applyUpdateSnapshot(
  ledger: UpdateLedger,
  previous: readonly IssueSummary[] | null,
  current: readonly IssueSummary[],
  options: { baseline?: boolean } = {},
): UpdateLedger {
  return ingestUpdateEvents(ledger, deriveUpdateEvents(previous, current, options), current);
}

export function isUpdateIssueUnread(ledger: UpdateLedger, issueId: IssueId): boolean {
  return !ledger.readIssueIds.some((id) => String(id) === String(issueId));
}

function validateIssueIds(issueIds: readonly IssueId[], activeIssueIds: readonly IssueId[], label: string): void {
  const allowed = activeSet(activeIssueIds);
  const invalid = [...new Set(issueIds.map(String))].filter((id) => !allowed.has(id));
  if (invalid.length > 0) throw new UpdateLedgerValidationError(`${label} contains issue outside authenticated view`);
}

/** Mark one or more groups read/unread locally, validating membership when supplied. */
export function markGroupsRead(
  ledger: UpdateLedger,
  issueIds: readonly IssueId[],
  read: boolean,
  activeIssueIds?: readonly IssueId[],
): UpdateLedger {
  if (activeIssueIds) validateIssueIds(issueIds, activeIssueIds, "mark-read issue IDs");
  const ids = new Map(ledger.readIssueIds.map((id) => [String(id), id]));
  for (const issueId of issueIds) {
    if (read) ids.set(String(issueId), issueId);
    else ids.delete(String(issueId));
  }
  return { ...ledger, readIssueIds: [...ids.values()].sort(compareIds) };
}

export function toggleGroupRead(ledger: UpdateLedger, issueId: IssueId, activeIssueIds?: readonly IssueId[]): UpdateLedger {
  return markGroupsRead(ledger, [issueId], isUpdateIssueUnread(ledger, issueId), activeIssueIds);
}

/** Mark all displayed groups read. The displayed set must be within the authenticated issue view. */
export function markAllDisplayedRead(
  ledger: UpdateLedger,
  displayedIssueIds: readonly IssueId[],
  activeIssueIds: readonly IssueId[],
): UpdateLedger {
  validateIssueIds(displayedIssueIds, activeIssueIds, "displayed issue IDs");
  return markGroupsRead(ledger, displayedIssueIds, true);
}

export function setGroupExpanded(ledger: UpdateLedger, issueId: IssueId, expanded: boolean): UpdateLedger {
  const ids = new Map(ledger.expandedIssueIds.map((id) => [String(id), id]));
  if (expanded) ids.set(String(issueId), issueId);
  else ids.delete(String(issueId));
  return { ...ledger, expandedIssueIds: [...ids.values()].sort(compareIds) };
}

/** Group newest-first and return at most three rows unless the group is expanded. */
export function updateGroups(
  ledger: UpdateLedger,
  filter: UpdateFilter = "all",
  options: { rowLimit?: number } = {},
): UpdateGroup[] {
  const rowLimit = Math.max(1, Math.min(DEFAULT_UPDATE_ROW_LIMIT, Math.floor(options.rowLimit ?? DEFAULT_UPDATE_ROW_LIMIT)));
  const read = new Set(ledger.readIssueIds.map(String));
  const expanded = new Set(ledger.expandedIssueIds.map(String));
  const grouped = new Map<string, UpdateEvent[]>();
  for (const event of ledger.events) {
    const list = grouped.get(String(event.issueId)) ?? [];
    list.push(event);
    grouped.set(String(event.issueId), list);
  }
  const result: UpdateGroup[] = [];
  for (const [id, events] of grouped) {
    const ordered = events.slice().sort(compareEvents);
    const unread = !read.has(id);
    if (filter === "unread" && !unread) continue;
    const first = ordered[0];
    if (!first) continue;
    const isExpanded = expanded.has(id);
    result.push({
      issueId: first.issueId,
      issueKey: first.issueKey,
      issueSummary: first.issueSummary,
      latestAt: first.occurredAt,
      unread,
      expanded: isExpanded,
      events: ordered,
      rows: isExpanded ? ordered : ordered.slice(0, rowLimit),
    });
  }
  return result.sort((a, b) => {
    const time = b.latestAt.localeCompare(a.latestAt);
    return time !== 0 ? time : compareIds(a.issueId, b.issueId);
  });
}

export const groupUpdateEvents = updateGroups;
