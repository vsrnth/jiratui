import { describe, expect, test } from "bun:test";
import { initialState, reduce, visibleUpdateGroups } from "../src/state";
import { parseIssueId, parseIssueKey } from "../src/domain";
import { applyUpdateSnapshot, emptyUpdateLedger } from "../src/updates/ledger";

const issues = [
  { id: parseIssueId("1"), key: parseIssueKey("ABC-123"), summary: "First issue", status: "Open", statusCategory: "to_do" as const, priority: "Medium", assignee: "Ada", updated: "2026-08-23T00:00:00Z" },
  { id: parseIssueId("2"), key: parseIssueKey("ABC-456"), summary: "Second issue", status: "Done", statusCategory: "done" as const, priority: "Low", assignee: "Bea", updated: "2026-08-22T00:00:00Z" },
  { id: parseIssueId("3"), key: parseIssueKey("ABC-789"), summary: "Progress issue", status: "In Progress", statusCategory: "in_progress" as const, priority: "High", assignee: "Cy", updated: "2026-08-21T00:00:00Z" },
];

const snapshot = (issuesValue: typeof issues, options: { source?: "cache" | "jira"; refreshedAt?: string; updates?: ReturnType<typeof emptyUpdateLedger>; updatesBaselineEstablished?: boolean } = {}) => ({
  type: "workspace_snapshot" as const,
  siteLabel: "site",
  identity: "user",
  issues: issuesValue,
  source: options.source ?? "cache",
  refreshedAt: options.refreshedAt ?? "now",
  generation: 0,
  updates: options.updates ?? emptyUpdateLedger(),
  updatesBaselineEstablished: options.updatesBaselineEstablished ?? false,
});

describe("root reducer", () => {
  test("clears credentials on failure while retaining URL and email", () => {
    let state = initialState();
    state = reduce(state, { type: "onboarding_text", value: "https://example.atlassian.net" });
    state = reduce(state, { type: "onboarding_field", field: "email" });
    state = reduce(state, { type: "onboarding_text", value: "ada@example.test" });
    state = reduce(state, { type: "onboarding_field", field: "token" });
    state = reduce(state, { type: "onboarding_token", value: "secret-token" });
    state = reduce(state, { type: "onboarding_submit_start" });
    const generation = state.generations.connect;
    state = reduce(state, { type: "onboarding_error", message: "Jira authentication was rejected", generation });
    expect(state.onboarding.baseUrl).toBe("https://example.atlassian.net");
    expect(state.onboarding.email).toBe("ada@example.test");
    expect(state.onboarding.token.value).toBe("");
    expect(state.onboarding.field).toBe("token");
    expect(state.onboarding.submitting).toBe(false);
  });

  test("cancellation advances connect generation and drops stale completion", () => {
    let state = reduce(initialState(), { type: "onboarding_submit_start" });
    const generation = state.generations.connect;
    state = reduce(state, { type: "onboarding_cancel" });
    expect(state.generations.connect).toBe(generation + 1);
    expect(state.lastMessage).toBe("Connection cancelled");
    expect(state.onboarding.field).toBe("token");
    expect(state.onboarding.submitting).toBe(false);
    const cancelled = state;
    expect(reduce(state, { type: "onboarding_error", message: "stale failure", generation })).toEqual(cancelled);
    expect(reduce(state, { type: "authenticated", siteLabel: "stale", identity: "stale", generation })).toEqual(cancelled);
  });

  test("authenticated transition clears any onboarding secret and submit state", () => {
    let state = reduce(initialState(), { type: "onboarding_submit_start" });
    state = reduce(state, { type: "onboarding_token", value: "secret-token" });
    const generation = state.generations.connect;
    state = reduce(state, { type: "authenticated", siteLabel: "site", identity: "Ada", generation });
    expect(state.phase).toBe("loading");
    expect(state.onboarding.token.value).toBe("");
    expect(state.onboarding.submitting).toBe(false);
    expect(state.onboarding.error).toBeNull();
  });

  test("filters locally and preserves complete key", () => {
    let state = initialState();
    state = reduce(state, snapshot(issues));
    state = reduce(state, { type: "set_search", value: "456" });
    expect(state.filteredIssues.map((issue) => issue.key)).toEqual([parseIssueKey("ABC-456")]);
    expect(state.selectedIssueKey).toBe(parseIssueKey("ABC-456"));
  });
  test("applies status categories atomically and intersects local search", () => {
    let state = reduce(initialState(), snapshot(issues));
    state = reduce(state, { type: "open_status_picker" });
    state = reduce(state, { type: "move_status_picker", delta: 1 });
    state = reduce(state, { type: "toggle_status_draft" });
    expect(state.statusFilter).toEqual([]);
    expect(state.statusDraft).toEqual(["in_progress"]);
    state = reduce(state, { type: "apply_status_filter" });
    expect(state.statusFilter).toEqual(["in_progress"]);
    expect(state.filteredIssues.map((issue) => issue.key)).toEqual([parseIssueKey("ABC-789")]);
    state = reduce(state, { type: "set_search", value: "Second" });
    expect(state.filteredIssues).toEqual([]);
  });
  test("cancels a draft status selection without changing applied filters", () => {
    let state = reduce(initialState(), snapshot(issues));
    state = reduce(state, { type: "open_status_picker" });
    state = reduce(state, { type: "move_status_picker", delta: 2 });
    state = reduce(state, { type: "toggle_status_draft" });
    state = reduce(state, { type: "cancel_status_filter" });
    expect(state.statusFilter).toEqual([]);
    expect(state.filteredIssues).toHaveLength(3);
    expect(state.focus).toBe("List");
  });
  test("preserves the selected issue key when filtering changes its index", () => {
    let state = reduce(initialState(), snapshot(issues));
    state = reduce(state, { type: "select_issue", index: 1 });
    state = reduce(state, { type: "open_status_picker" });
    state = reduce(state, { type: "move_status_picker", delta: 1 });
    state = reduce(state, { type: "toggle_status_draft" });
    state = reduce(state, { type: "move_status_picker", delta: 1 });
    state = reduce(state, { type: "toggle_status_draft" });
    state = reduce(state, { type: "apply_status_filter" });
    expect(state.filteredIssues.map((issue) => issue.key)).toEqual([parseIssueKey("ABC-456"), parseIssueKey("ABC-789")]);
    expect(state.selectedIndex).toBe(0);
    expect(state.selectedIssueKey).toBe(parseIssueKey("ABC-456"));
  });
  test("clears incompatible detail state when search removes the selected issue", () => {
    let state = reduce(initialState(), snapshot(issues));
    state = reduce(state, { type: "detail_start", issueKey: "ABC-123" });
    const pendingGeneration = state.generations.detail;
    state = { ...state, detailError: "old error" };
    state = reduce(state, { type: "set_search", value: "Second" });
    expect(state.selectedIssueKey).toBe(parseIssueKey("ABC-456"));
    expect(state.detail).toBeNull();
    expect(state.detailLoading).toBe(false);
    expect(state.detailError).toBeNull();
    expect(state.generations.detail).toBe(pendingGeneration + 1);
    state = reduce(state, { type: "detail_error", message: "stale error", generation: pendingGeneration });
    expect(state.detailError).toBeNull();
  });
  test("drops stale detail generations", () => {
    let state = initialState();
    state = reduce(state, snapshot(issues));
    state = reduce(state, { type: "detail_start", issueKey: "ABC-123" });
    state = reduce(state, { type: "detail_result", issueKey: "ABC-123", generation: 0, issue: { issue: issues[0]!, issueType: "Task", reporter: "Ada", project: "ABC", parent: null, labels: [], dueDate: null, created: "2026-08-20", description: "old", comments: [], attachments: [], remote: false } });
    expect(state.detail).toBeNull();
    state = reduce(state, { type: "detail_result", issueKey: "ABC-123", generation: 1, issue: { issue: issues[0]!, issueType: "Task", reporter: "Ada", project: "ABC", parent: null, labels: [], dueDate: null, created: "2026-08-20", description: "new", comments: [], attachments: [], remote: false } });
    expect(state.detail?.description).toBe("new");
  });
  test("ignores stale and future workspace snapshot generations", () => {
    let state = initialState();
    const canonical = { ...emptyUpdateLedger(), readIssueIds: [issues[0]!.id] };
    state = reduce(state, snapshot(issues, { refreshedAt: "initial", updates: canonical, updatesBaselineEstablished: true }));
    state = reduce(state, { type: "refresh_start" });
    const current = state;
    expect(current.updates).toEqual(canonical);

    expect(reduce(state, { ...snapshot([issues[1]!], { source: "jira", refreshedAt: "stale" }), generation: 0 })).toEqual(current);
    expect(reduce(state, { ...snapshot([issues[1]!], { source: "jira", refreshedAt: "future" }), generation: 2 })).toEqual(current);
  });
  test("adopts canonical update ledgers from workspace snapshots", () => {
    let state = initialState();
    state = reduce(state, snapshot(issues, { refreshedAt: "initial", updatesBaselineEstablished: true }));
    expect(state.updates.events).toHaveLength(0);
    expect(state.updatesBaselineEstablished).toBe(true);

    const changed = { ...issues[0]!, status: "Done", statusCategory: "done" as const, priority: "High", updated: "2026-08-24T01:00:00Z" };
    const canonical = applyUpdateSnapshot(emptyUpdateLedger(), issues, [changed, issues[1]!]);
    state = reduce(state, snapshot([changed, issues[1]!], { source: "jira", refreshedAt: "later", updates: canonical, updatesBaselineEstablished: true }));
    expect(state.updates.events.map((item) => item.field)).toEqual(["status", "priority"]);
    expect(visibleUpdateGroups(state)).toHaveLength(1);
    expect(visibleUpdateGroups(state)[0]?.issueKey).toBe(parseIssueKey("ABC-123"));
  });
  test("resets the issue and update view on a replacement authentication", () => {
    let state = reduce(initialState(), snapshot(issues, { refreshedAt: "old", updatesBaselineEstablished: true }));
    state = reduce(state, { type: "authenticated", siteLabel: "new", identity: "new", generation: state.generations.connect });
    expect(state.issues).toHaveLength(0);
    expect(state.detail).toBeNull();
    expect(state.updates.events).toHaveLength(0);
    expect(state.updatesBaselineEstablished).toBe(false);
  });
  test("supports update filter, read state, expansion, and confirmed mark-all", () => {
    let state = initialState();
    state = reduce(state, snapshot(issues, { refreshedAt: "initial", updatesBaselineEstablished: true }));
    const changedIssues = issues.map((issue, index) => index === 0 ? { ...issue, summary: "Changed", updated: "2026-08-24T01:00:00Z" } : issue);
    state = reduce(state, snapshot(changedIssues, { source: "jira", refreshedAt: "later", updates: applyUpdateSnapshot(emptyUpdateLedger(), issues, changedIssues), updatesBaselineEstablished: true }));
    expect(visibleUpdateGroups(state)).toHaveLength(1);
    state = reduce(state, { type: "toggle_update_expanded" });
    expect(visibleUpdateGroups(state)[0]?.expanded).toBe(true);
    state = reduce(state, { type: "toggle_update_filter" });
    expect(state.updateFilter).toBe("all");
    state = reduce(state, { type: "toggle_update_read" });
    expect(visibleUpdateGroups(state)[0]?.unread).toBe(false);

    const second = { ...issues[1]!, summary: "Changed too", updated: "2026-08-24T02:00:00Z" };
    const secondIssues = [issues[0]!, second];
    state = reduce(state, snapshot(secondIssues, { source: "jira", refreshedAt: "later-2", updates: applyUpdateSnapshot(state.updates, [changedIssues[0]!, issues[1]!], secondIssues), updatesBaselineEstablished: true }));
    state = reduce(state, { type: "request_mark_all_updates" });
    expect(state.confirmMarkAllUpdates).toBe(true);
    state = reduce(state, { type: "confirm_mark_all_updates", value: true });
    expect(visibleUpdateGroups(state).every((group) => !group.unread)).toBe(true);
  });
  test("bounds event log and handles explicit overlays", () => {
    let state = initialState();
    for (let index = 0; index < 70; index += 1) state = reduce(state, { type: "message", message: `event ${index}` });
    expect(state.events).toHaveLength(64);
    state = reduce(state, { type: "toggle_help" });
    expect(state.overlays.help).toBe(true);
    expect(state.focus).toBe("Help");
  });
});
