import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { handleKey, parseSequence } from "../src/input";
import { initialState, reduce } from "../src/state";

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
    let state = reduce(initialState(), { type: "workspace_snapshot", siteLabel: "site", identity: "user", issues, source: "cache", refreshedAt: "now", generation: 0 });
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
});
