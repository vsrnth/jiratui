import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { handleKey, parseSequence } from "../src/input";
import { initialState, reduce } from "../src/state";
import type { IssueSummary } from "../src/domain";
import { applyUpdateSnapshot, emptyUpdateLedger, type UpdateLedger } from "../src/updates/ledger";

const workspaceSnapshot = (issues: readonly IssueSummary[], options: { source?: "cache" | "jira"; refreshedAt?: string; updates?: UpdateLedger; updatesBaselineEstablished?: boolean } = {}) => ({
  type: "workspace_snapshot" as const,
  siteLabel: "site",
  identity: "user",
  issues,
  source: options.source ?? "cache",
  refreshedAt: options.refreshedAt ?? "now",
  generation: 0,
  updates: options.updates ?? emptyUpdateLedger(),
  updatesBaselineEstablished: options.updatesBaselineEstablished ?? false,
});

describe("key handling", () => {
  test("uses explicit focus traversal and escape unwinds help", () => {
    let state = initialState();
    state = reduce(state, { type: "toggle_help" });
    expect(handleKey(state, { name: "escape" }).state.overlays.help).toBe(false);
    const tabbed = handleKey({ ...initialState(), phase: "ready", focus: "Nav" }, { name: "tab" }).state;
    expect(tabbed.focus).toBe("Search");
  });
  test("parses resize and never echoes token in mask action", () => {
    expect(parseSequence("\u001b[A").name).toBe("up");
    let state = initialState();
    state = reduce(state, { type: "onboarding_field", field: "token" });
    const next = handleKey(state, { sequence: "s", name: "s" }).state;
    expect(next.onboarding.token.value).toBe("s");
  });
  test("onboarding consumes shortcuts as field text and advances with tab/enter", () => {
    let state = initialState();
    state = handleKey(state, { sequence: "q", name: "q" }).state;
    expect(state.onboarding.baseUrl).toBe("q");
    state = handleKey(state, { name: "tab", sequence: "\t" }).state;
    expect(state.onboarding.field).toBe("email");
    state = handleKey(state, { name: "enter", sequence: "\r" }).state;
    expect(state.onboarding.field).toBe("token");
  });
  test("normalizes return and linefeed events throughout onboarding", () => {
    let state = initialState();
    state = handleKey(state, { name: "return", sequence: "\r" }).state;
    expect(state.onboarding.field).toBe("email");
    state = handleKey(state, { name: "linefeed", sequence: "\n" }).state;
    expect(state.onboarding.field).toBe("token");

    expect(handleKey(state, { name: "return", sequence: "\r" }).command).toBe("connect");
    state = reduce(state, { type: "onboarding_field", field: "remember" });
    expect(handleKey(state, { name: "linefeed", sequence: "\n" }).command).toBe("connect");
  });

  test("clears the token on Ctrl-G without producing a command", () => {
    let state = reduce(initialState(), { type: "onboarding_field", field: "token" });
    state = reduce(state, { type: "onboarding_token", value: "secret-token" });
    const result = handleKey(state, { name: "g", sequence: "\u0007", ctrl: true });
    expect(result.command).toBeNull();
    expect(result.state.onboarding.token.value).toBe("");
    expect(result.state.events).toHaveLength(0);
    expect(parseSequence("\u0007")).toEqual({ name: "g", sequence: "\u0007", ctrl: true });
  });

  test("blocks duplicate connect submits and exposes typed cancellation", () => {
    let state = reduce(initialState(), { type: "onboarding_field", field: "token" });
    state = reduce(state, { type: "onboarding_submit_start" });
    const duplicate = handleKey(state, { name: "return", sequence: "\r" });
    expect(duplicate.command).toBeNull();
    expect(duplicate.state).toBe(state);

    const cancelled = handleKey(state, { name: "escape", sequence: "\u001b" });
    expect(cancelled.command).toBe("cancel_connect");
    expect(cancelled.state.onboarding.submitting).toBe(false);
    expect(cancelled.state.onboarding.field).toBe("token");
    expect(cancelled.state.lastMessage).toBe("Connection cancelled");
  });

  test("OpenTUI's parsed return event triggers connect from a populated token field", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    let listener: ((event: Parameters<typeof setup.renderer.keyInput.emit>[1]) => void) | null = null;
    try {
      let state = initialState();
      state = reduce(state, { type: "onboarding_text", value: "https://example.atlassian.net" });
      state = reduce(state, { type: "onboarding_field", field: "email" });
      state = reduce(state, { type: "onboarding_text", value: "ada@example.test" });
      state = reduce(state, { type: "onboarding_field", field: "token" });
      state = reduce(state, { type: "onboarding_token", value: "secret-token" });
      let command: ReturnType<typeof handleKey>["command"] = null;
      listener = (event) => {
        const result = handleKey(state, event);
        state = result.state;
        command = result.command;
      };
      setup.renderer.keyInput.on("keypress", listener);
      setup.mockInput.pressEnter();
      await setup.renderOnce();
      expect(command as "connect" | null).toBe("connect");
      expect(state.onboarding.token.value).toBe("secret-token");
    } finally {
      if (listener) setup.renderer.keyInput.off("keypress", listener);
      setup.renderer.destroy();
    }
  });
  test("exact lookup has a dedicated editor", () => {
    const result = handleKey({ ...initialState(), phase: "ready", focus: "List" }, { name: "l", sequence: "l" });
    expect(result.command).toBe("lookup");
    const editing = handleKey({ ...result.state, focus: "Picker" }, { name: "A", sequence: "A" }).state;
    expect(editing.lookupEditor).toBe("A");
  });
  test("opens the status picker with s and applies on OpenTUI return", () => {
    const issues = [{ id: "1" as never, key: "ABC-1" as never, summary: "Progress", status: "In Progress", statusCategory: "in_progress" as const, priority: "Medium", assignee: "Ada", updated: "now" }];
    let state = reduce(initialState(), workspaceSnapshot(issues));
    state = { ...state, phase: "ready", focus: "List" };
    let result = handleKey(state, { name: "s", sequence: "s" });
    expect(result.state.pickerMode).toBe("status");
    result = handleKey(result.state, { name: "down", sequence: "\u001b[B" });
    result = handleKey(result.state, { name: "space", sequence: " " });
    result = handleKey(result.state, { name: "return", sequence: "\r" });
    expect(result.state.statusFilter).toEqual(["in_progress"]);
    expect(result.state.focus).toBe("List");
  });
  test("requires explicit confirmation before deleting a saved login", () => {
    const settings = reduce({ ...initialState(), phase: "ready" }, { type: "set_section", section: "settings" });
    const prompt = handleKey(settings, { name: "f", sequence: "f" });
    expect(prompt.command).toBeNull();
    expect(prompt.state.confirmForgetLogin).toBe(true);

    const cancelled = handleKey(prompt.state, { name: "n", sequence: "n" });
    expect(cancelled.command).toBeNull();
    expect(cancelled.state.confirmForgetLogin).toBe(false);

    const confirmed = handleKey(prompt.state, { name: "y", sequence: "y" });
    expect(confirmed.command).toBe("forget_login");
    expect(confirmed.state.confirmForgetLogin).toBe(false);
  });
  test("keeps Updates controls local and opens the selected issue on Enter", () => {
    let state = initialState();
    const issue = { id: "1" as never, key: "ABC-1" as never, summary: "Original", status: "Open", statusCategory: "to_do" as const, priority: "Medium", assignee: "Ada", updated: "2026-08-23T00:00:00Z" };
    state = reduce(state, workspaceSnapshot([issue], { refreshedAt: "initial", updatesBaselineEstablished: true }));
    const changed = { ...issue, summary: "Changed", updated: "2026-08-24T00:00:00Z" };
    state = reduce(state, workspaceSnapshot([changed], { source: "jira", refreshedAt: "later", updates: applyUpdateSnapshot(emptyUpdateLedger(), [issue as never], [changed as never]), updatesBaselineEstablished: true }));
    state = reduce(state, { type: "set_section", section: "updates" });
    expect(handleKey(state, { name: "r", sequence: "r" }).state.lastMessage).toBe("Local updates are already current");
    expect(handleKey(state, { name: "r", sequence: "r" }).command).toBeNull();
    const expandedResult = handleKey(state, { name: "space", sequence: " " });
    expect(expandedResult.command).toBe("persist_updates");
    const expanded = expandedResult.state;
    expect(expanded.updates.expandedIssueIds).toHaveLength(1);
    const all = handleKey(expanded, { name: "u", sequence: "u" }).state;
    expect(all.updateFilter).toBe("all");
    const toggledResult = handleKey(all, { name: "m", sequence: "m" });
    expect(toggledResult.command).toBe("persist_updates");
    const toggled = toggledResult.state;
    expect(toggled.updates.readIssueIds).toHaveLength(1);
    const selected = handleKey(toggled, { name: "enter", sequence: "\r" });
    expect(selected.command).toBe("detail");
    expect(selected.state.section).toBe("issues");
    expect(selected.state.selectedIssueKey).toBe("ABC-1");
  });
  test("requires confirmation for marking multiple displayed update groups read", () => {
    const issue = (id: string, key: string) => ({ id: id as never, key: key as never, summary: key, status: "Open", statusCategory: "to_do" as const, priority: "Medium", assignee: "Ada", updated: "2026-08-23T00:00:00Z" });
    const first = issue("1", "ABC-1");
    const second = issue("2", "ABC-2");
    let state = reduce(initialState(), workspaceSnapshot([first, second], { refreshedAt: "initial", updatesBaselineEstablished: true }));
    const changedFirst = { ...first, summary: "Changed", updated: "2026-08-24T00:00:00Z" };
    const changedSecond = { ...second, summary: "Changed", updated: "2026-08-24T00:01:00Z" };
    state = reduce(state, workspaceSnapshot([changedFirst, changedSecond], { source: "jira", refreshedAt: "later", updates: applyUpdateSnapshot(emptyUpdateLedger(), [first as never, second as never], [changedFirst as never, changedSecond as never]), updatesBaselineEstablished: true }));
    state = reduce(state, { type: "set_section", section: "updates" });
    const prompted = handleKey(state, { name: "M", sequence: "M", shift: true });
    expect(prompted.state.confirmMarkAllUpdates).toBe(true);
    expect(handleKey(prompted.state, { name: "n", sequence: "n" }).state.confirmMarkAllUpdates).toBe(false);
    const confirmedResult = handleKey(prompted.state, { name: "y", sequence: "y" });
    expect(confirmedResult.command).toBe("persist_updates");
    const confirmed = confirmedResult.state;
    expect(confirmed.confirmMarkAllUpdates).toBe(false);
    expect(confirmed.updates.readIssueIds).toHaveLength(2);
  });
  test("keeps issue selection stable while navigating Updates until Enter activates", () => {
    const issue = (id: string, key: string) => ({ id: id as never, key: key as never, summary: key, status: "Open", statusCategory: "to_do" as const, priority: "Medium", assignee: "Ada", updated: "2026-08-23T00:00:00Z" });
    const first = issue("1", "ABC-1");
    const second = issue("2", "ABC-2");
    let state = reduce(initialState(), workspaceSnapshot([first, second], { refreshedAt: "initial", updatesBaselineEstablished: true }));
    state = reduce(state, { type: "select_issue", index: 1 });
    const changedFirst = { ...first, summary: "Changed first", updated: "2026-08-24T00:01:00Z" };
    const changedSecond = { ...second, summary: "Changed second", updated: "2026-08-24T00:02:00Z" };
    state = reduce(state, workspaceSnapshot([changedFirst, changedSecond], { source: "jira", refreshedAt: "later", updates: applyUpdateSnapshot(emptyUpdateLedger(), [first as never, second as never], [changedFirst as never, changedSecond as never]), updatesBaselineEstablished: true }));
    state = reduce(state, { type: "set_section", section: "updates" });
    const issueIndex = state.selectedIndex;
    const issueKey = state.selectedIssueKey;
    const moved = handleKey(state, { name: "j", sequence: "j" }).state;
    expect(moved.selectedUpdateIndex).toBe(1);
    expect(moved.selectedIndex).toBe(issueIndex);
    expect(moved.selectedIssueKey).toBe(issueKey);
    const activated = handleKey(moved, { name: "enter", sequence: "\r" }).state;
    expect(activated.selectedIssueKey).toBe("ABC-1");
  });

  test("does not request persistence for navigation, filtering, refresh, or no-op update controls", () => {
    const state = { ...initialState(), phase: "ready" as const, section: "updates" as const };
    expect(handleKey(state, { name: "j", sequence: "j" }).command).toBeNull();
    expect(handleKey(state, { name: "u", sequence: "u" }).command).toBeNull();
    expect(handleKey(state, { name: "r", sequence: "r" }).command).toBeNull();
    expect(handleKey(state, { name: "m", sequence: "m" }).command).toBeNull();
    expect(handleKey(state, { name: "space", sequence: " " }).command).toBeNull();
    expect(handleKey(state, { name: "M", sequence: "M", shift: true }).command).toBeNull();
  });

  test("adopting canonical persistence keeps selection and applied issue filter", () => {
    const issue = { id: "1" as never, key: "ABC-1" as never, summary: "Original", status: "Open", statusCategory: "to_do" as const, priority: "Medium", assignee: "Ada", updated: "2026-08-23T00:00:00Z" };
    let state = reduce(initialState(), workspaceSnapshot([issue], { updatesBaselineEstablished: true }));
    state = reduce(state, { type: "set_search", value: "ABC-1" });
    state = reduce(state, { type: "set_section", section: "updates" });
    const selectedKey = state.selectedIssueKey;
    const canonical = { events: state.updates.events, readIssueIds: [issue.id], expandedIssueIds: [] };
    state = reduce(state, { type: "updates_persisted", updates: canonical });
    expect(state.selectedIssueKey).toBe(selectedKey);
    expect(state.search).toBe("ABC-1");
    expect(state.filteredIssues).toHaveLength(1);
    expect(state.updates.readIssueIds).toEqual([issue.id]);
  });
});
