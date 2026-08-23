import { describe, expect, test } from "bun:test";
import { initialState, reduce } from "../src/state";
import { parseIssueId, parseIssueKey } from "../src/domain";

const issues = [
  { id: parseIssueId("1"), key: parseIssueKey("ABC-123"), summary: "First issue", status: "Open", statusCategory: "to_do" as const, priority: "Medium", assignee: "Ada", updated: "2026-08-23T00:00:00Z" },
  { id: parseIssueId("2"), key: parseIssueKey("ABC-456"), summary: "Second issue", status: "Done", statusCategory: "done" as const, priority: "Low", assignee: "Bea", updated: "2026-08-22T00:00:00Z" },
];

describe("root reducer", () => {
  test("filters locally and preserves complete key", () => {
    let state = initialState();
    state = reduce(state, { type: "workspace_snapshot", siteLabel: "example.atlassian.net", identity: "Ada", issues, source: "cache", refreshedAt: "now", generation: 0 });
    state = reduce(state, { type: "set_search", value: "456" });
    expect(state.filteredIssues.map((issue) => issue.key)).toEqual([parseIssueKey("ABC-456")]);
    expect(state.selectedIssueKey).toBe(parseIssueKey("ABC-456"));
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
