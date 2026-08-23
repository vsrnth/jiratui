import { describe, expect, test } from "bun:test";
import { initialState, reduce } from "../src/state";
import { parseIssueId, parseIssueKey } from "../src/domain";

const issues = [
  { id: parseIssueId("1"), key: parseIssueKey("ABC-123"), summary: "First issue", status: "Open", statusCategory: "to_do" as const, priority: "Medium", assignee: "Ada", updated: "2026-08-23T00:00:00Z" },
  { id: parseIssueId("2"), key: parseIssueKey("ABC-456"), summary: "Second issue", status: "Done", statusCategory: "done" as const, priority: "Low", assignee: "Bea", updated: "2026-08-22T00:00:00Z" },
  { id: parseIssueId("3"), key: parseIssueKey("ABC-789"), summary: "Progress issue", status: "In Progress", statusCategory: "in_progress" as const, priority: "High", assignee: "Cy", updated: "2026-08-21T00:00:00Z" },
];

describe("root reducer", () => {
  test("filters locally and preserves complete key", () => {
    let state = initialState();
    state = reduce(state, { type: "workspace_snapshot", siteLabel: "example.atlassian.net", identity: "Ada", issues, source: "cache", refreshedAt: "now", generation: 0 });
    state = reduce(state, { type: "set_search", value: "456" });
    expect(state.filteredIssues.map((issue) => issue.key)).toEqual([parseIssueKey("ABC-456")]);
    expect(state.selectedIssueKey).toBe(parseIssueKey("ABC-456"));
  });
  test("applies status categories atomically and intersects local search", () => {
    let state = reduce(initialState(), { type: "workspace_snapshot", siteLabel: "site", identity: "user", issues, source: "cache", refreshedAt: "now", generation: 0 });
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
    let state = reduce(initialState(), { type: "workspace_snapshot", siteLabel: "site", identity: "user", issues, source: "cache", refreshedAt: "now", generation: 0 });
    state = reduce(state, { type: "open_status_picker" });
    state = reduce(state, { type: "move_status_picker", delta: 2 });
    state = reduce(state, { type: "toggle_status_draft" });
    state = reduce(state, { type: "cancel_status_filter" });
    expect(state.statusFilter).toEqual([]);
    expect(state.filteredIssues).toHaveLength(3);
    expect(state.focus).toBe("List");
  });
  test("preserves the selected issue key when filtering changes its index", () => {
    let state = reduce(initialState(), { type: "workspace_snapshot", siteLabel: "site", identity: "user", issues, source: "cache", refreshedAt: "now", generation: 0 });
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
    let state = reduce(initialState(), { type: "workspace_snapshot", siteLabel: "site", identity: "user", issues, source: "cache", refreshedAt: "now", generation: 0 });
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
    state = reduce(state, { type: "workspace_snapshot", siteLabel: "site", identity: "user", issues, source: "cache", refreshedAt: "now", generation: 0 });
    state = reduce(state, { type: "detail_start", issueKey: "ABC-123" });
    state = reduce(state, { type: "detail_result", issueKey: "ABC-123", generation: 0, issue: { issue: issues[0]!, issueType: "Task", reporter: "Ada", project: "ABC", parent: null, labels: [], dueDate: null, created: "2026-08-20", description: "old", comments: [], attachments: [], remote: false } });
    expect(state.detail).toBeNull();
    state = reduce(state, { type: "detail_result", issueKey: "ABC-123", generation: 1, issue: { issue: issues[0]!, issueType: "Task", reporter: "Ada", project: "ABC", parent: null, labels: [], dueDate: null, created: "2026-08-20", description: "new", comments: [], attachments: [], remote: false } });
    expect(state.detail?.description).toBe("new");
  });
  test("ignores stale and future workspace snapshot generations", () => {
    let state = initialState();
    state = reduce(state, { type: "workspace_snapshot", siteLabel: "site", identity: "user", issues, source: "cache", refreshedAt: "initial", generation: 0 });
    state = reduce(state, { type: "refresh_start" });
    const current = state;

    expect(reduce(state, { type: "workspace_snapshot", siteLabel: "site", identity: "user", issues: [issues[1]!], source: "jira", refreshedAt: "stale", generation: 0 })).toEqual(current);
    expect(reduce(state, { type: "workspace_snapshot", siteLabel: "site", identity: "user", issues: [issues[1]!], source: "jira", refreshedAt: "future", generation: 2 })).toEqual(current);
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
