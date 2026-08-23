import { describe, expect, test } from "bun:test";
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
  test("exact lookup has a dedicated editor", () => {
    const result = handleKey({ ...initialState(), phase: "ready", focus: "List" }, { name: "l", sequence: "l" });
    expect(result.command).toBe("lookup");
    const editing = handleKey({ ...result.state, focus: "Picker" }, { name: "A", sequence: "A" }).state;
    expect(editing.lookupEditor).toBe("A");
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
