import { backspaceSecret, deleteSecret, editSecret, moveSecret } from "./secure-input";
import { reduce, type Action, type Focus, type RootState } from "./state";

export type KeyLike = { name?: string; sequence?: string; ctrl?: boolean; shift?: boolean; meta?: boolean };
export type InputCommand = "quit" | "connect" | "cancel_connect" | "refresh" | "reload_preferences" | "save_appearance" | "detail" | "lookup" | "lookup_submit" | "focus_search" | "retry_resize" | "forget_login" | "persist_updates" | null;
export type InputResult = { state: RootState; command: InputCommand };
const focusOrder: Focus[] = ["Nav", "Search", "List", "Detail", "Composer", "Picker", "Settings"];

export function keyName(key: KeyLike): string {
  if (key.name) {
    const name = key.name.toLowerCase();
    return name === "return" || name === "linefeed" ? "enter" : name;
  }
  if (key.sequence === "\u001b") return "escape";
  return key.sequence ?? "";
}

function moveFocus(state: RootState, delta: number): RootState {
  const index = Math.max(0, focusOrder.indexOf(state.focus));
  return reduce(state, { type: "set_focus", focus: focusOrder[(index + delta + focusOrder.length) % focusOrder.length] ?? "List" });
}

function updateMutation(state: RootState, action: Action): InputResult {
  const next = reduce(state, action);
  return { state: next, command: next.updates !== state.updates ? "persist_updates" : null };
}

export function handleKey(state: RootState, key: KeyLike): InputResult {
  const name = keyName(key);
  if (state.overlays.help || state.overlays.eventLog) {
    if (name === "escape" || name === "q") return { state: reduce(state, state.overlays.help ? { type: "toggle_help" } : { type: "toggle_event_log" }), command: null };
    if (name === "up" || name === "k") return { state: reduce(state, { type: "scroll", delta: -1 }), command: null };
    if (name === "down" || name === "j") return { state: reduce(state, { type: "scroll", delta: 1 }), command: null };
    return { state, command: null };
  }
  // Onboarding owns all printable keys. Global q/r/l shortcuts must not eat
  // credentials while a field is active.
  if (state.phase === "onboarding") {
    const fields: Array<"baseUrl" | "email" | "token" | "remember"> = ["baseUrl", "email", "token", "remember"];
    const fieldIndex = Math.max(0, fields.indexOf(state.onboarding.field));
    if (key.ctrl && name === "g") return { state: reduce(state, { type: "onboarding_clear_token" }), command: null };
    if (state.onboarding.submitting) {
      if (name === "escape") return { state: reduce(state, { type: "onboarding_cancel" }), command: "cancel_connect" };
      // Do not let duplicate submits or edits race the active connection.
      return { state, command: null };
    }
    if (name === "tab") {
      const next = fields[(fieldIndex + (key.shift ? -1 : 1) + fields.length) % fields.length] ?? "baseUrl";
      return { state: reduce(state, { type: "onboarding_field", field: next }), command: null };
    }
    if (name === "enter") {
      if (state.onboarding.field === "remember" || state.onboarding.field === "token") return { state, command: "connect" };
      const next = fields[fieldIndex + 1] ?? "token";
      return { state: reduce(state, { type: "onboarding_field", field: next }), command: null };
    }
    if (name === "space" || key.sequence === " ") {
      if (state.onboarding.field === "remember") return { state: reduce(state, { type: "toggle_remember" }), command: null };
      return { state, command: null };
    }
    if (name === "backspace") {
      if (state.onboarding.field === "token") return { state: { ...state, onboarding: { ...state.onboarding, token: backspaceSecret(state.onboarding.token) } }, command: null };
      if (state.onboarding.field === "baseUrl" || state.onboarding.field === "email") {
        const value = state.onboarding[state.onboarding.field];
        return { state: reduce(state, { type: "onboarding_text", value: value.slice(0, -1) }), command: null };
      }
      return { state, command: null };
    }
    if (name === "delete" && state.onboarding.field === "token") return { state: { ...state, onboarding: { ...state.onboarding, token: deleteSecret(state.onboarding.token) } }, command: null };
    if (name === "left" && state.onboarding.field === "token") return { state: { ...state, onboarding: { ...state.onboarding, token: moveSecret(state.onboarding.token, -1) } }, command: null };
    if (name === "right" && state.onboarding.field === "token") return { state: { ...state, onboarding: { ...state.onboarding, token: moveSecret(state.onboarding.token, 1) } }, command: null };
    const onboardingText = key.sequence ?? "";
    if (onboardingText.length === 1 && onboardingText >= " " && state.onboarding.field !== "remember") {
      if (state.onboarding.field === "token") return { state: { ...state, onboarding: { ...state.onboarding, token: editSecret(state.onboarding.token, onboardingText) } }, command: null };
      return { state: reduce(state, { type: "onboarding_text", value: state.onboarding[state.onboarding.field] + onboardingText }), command: null };
    }
    return { state, command: null };
  }
  if (state.focus === "Picker" && state.pickerMode === "status") {
    if (name === "escape") return { state: reduce(state, { type: "cancel_status_filter" }), command: null };
    if (name === "enter") return { state: reduce(state, { type: "apply_status_filter" }), command: null };
    if (name === "up" || name === "k") return { state: reduce(state, { type: "move_status_picker", delta: -1 }), command: null };
    if (name === "down" || name === "j") return { state: reduce(state, { type: "move_status_picker", delta: 1 }), command: null };
    if (name === "space" || key.sequence === " ") return { state: reduce(state, { type: "toggle_status_draft" }), command: null };
    return { state, command: null };
  }
  if (state.focus === "Search") {
    if (name === "backspace") return { state: reduce(state, { type: "set_search", value: state.search.slice(0, -1) }), command: null };
    const searchText = key.sequence ?? "";
    if (searchText.length === 1 && searchText >= " " && !key.ctrl && !key.meta) return { state: reduce(state, { type: "set_search", value: state.search + searchText }), command: null };
  }
  if (state.focus === "Picker") {
    if (name === "backspace") return { state: reduce(state, { type: "set_lookup", value: state.lookupEditor.slice(0, -1) }), command: null };
    const lookupText = key.sequence ?? "";
    if (lookupText.length === 1 && lookupText >= " " && !key.ctrl && !key.meta) return { state: reduce(state, { type: "set_lookup", value: state.lookupEditor + lookupText }), command: null };
  }
  if (state.confirmForgetLogin) {
    if (name === "y") return { state: reduce(state, { type: "confirm_forget_login", value: false }), command: "forget_login" };
    if (name === "n" || name === "escape") return { state: reduce(state, { type: "confirm_forget_login", value: false }), command: null };
    return { state, command: null };
  }
  if (state.confirmMarkAllUpdates) {
    if (name === "y") return updateMutation(state, { type: "confirm_mark_all_updates", value: true });
    if (name === "n" || name === "escape") return { state: reduce(state, { type: "confirm_mark_all_updates", value: false }), command: null };
    return { state, command: null };
  }
  const sections = { "1": "issues", "2": "updates", "3": "team", "4": "settings" } as const;
  if (name in sections) return { state: reduce(state, { type: "set_section", section: sections[name as keyof typeof sections] }), command: null };
  if (state.section === "settings") {
    if (key.ctrl && name === "s") return { state, command: "save_appearance" };
    if (key.ctrl && name === "r") return { state, command: "reload_preferences" };
    if (name === "x") return { state: reduce(state, { type: "appearance_restore" }), command: null };
    if (name === "up" || name === "k") return { state: reduce(state, { type: "appearance_move", delta: -1 }), command: null };
    if (name === "down" || name === "j") return { state: reduce(state, { type: "appearance_move", delta: 1 }), command: null };
    if (name === "space" || key.sequence === " " || name === "enter") return { state: reduce(state, { type: "appearance_cycle" }), command: null };
  }
  if (state.section === "updates") {
    const uppercaseM = key.sequence === "M" || key.name === "M" || (name === "m" && key.shift === true);
    if (name === "up" || name === "k") return { state: reduce(state, { type: "move_update_selection", delta: -1 }), command: null };
    if (name === "down" || name === "j") return { state: reduce(state, { type: "move_update_selection", delta: 1 }), command: null };
    if (name === "u") return { state: reduce(state, { type: "toggle_update_filter" }), command: null };
    if (name === "m" && !uppercaseM) return updateMutation(state, { type: "toggle_update_read" });
    if (name === "space" || key.sequence === " " || name === "o") return updateMutation(state, { type: "toggle_update_expanded" });
    if (uppercaseM) return updateMutation(state, { type: "request_mark_all_updates" });
    if (name === "r") return { state: reduce(state, { type: "message", message: "Local updates are already current", kind: "info" }), command: null };
    if (name === "enter") return { state: reduce(state, { type: "select_update_issue" }), command: "detail" };
  }
  if (state.section === "settings" && name === "f") {
    return { state: reduce(state, { type: "confirm_forget_login", value: true }), command: null };
  }
  if (name === "q" && !key.ctrl) return { state, command: "quit" };
  if (name === "?" || (name === "/" && key.ctrl)) return { state: reduce(state, { type: "toggle_help" }), command: null };
  if (name === "e") return { state: reduce(state, { type: "toggle_event_log" }), command: null };
  if (name === "s" && state.section === "issues") return { state: reduce(state, { type: "open_status_picker" }), command: null };
  if (name === "tab") return { state: moveFocus(state, key.shift ? -1 : 1), command: null };
  if (name === "escape") return { state: reduce(state, { type: "set_focus", focus: "List" }), command: null };
  if (name === "up" || name === "k") return { state: reduce(state, { type: "move_selection", delta: -1 }), command: null };
  if (name === "down" || name === "j") return { state: reduce(state, { type: "move_selection", delta: 1 }), command: null };
  if (name === "pageup" || (name === "u" && key.ctrl)) return { state: reduce(state, { type: "scroll", delta: -10 }), command: null };
  if (name === "pagedown" || (name === "d" && key.ctrl)) return { state: reduce(state, { type: "scroll", delta: 10 }), command: null };
  if (name === "r") {
    if (state.section !== "issues") return { state: reduce(state, { type: "message", message: "This section has no remote refresh", kind: "info" }), command: null };
    return { state: reduce(state, { type: "refresh_start" }), command: "refresh" };
  }
  if (name === "l") return { state, command: "lookup" };
  if (name === "enter") return { state, command: state.focus === "List" ? "detail" : state.focus === "Picker" ? "lookup_submit" : null };
  if (name === "ctrl-l" || (name === "l" && key.ctrl)) return { state, command: "retry_resize" };
  if (name === "/") return { state: reduce(state, { type: "set_focus", focus: "Search" }), command: "focus_search" };

  return { state, command: null };
}

/** Parse OpenTUI's raw sequence input without putting an unmasked secret in a widget. */
export function parseSequence(sequence: string): KeyLike {
  const table: Record<string, string> = { "\r": "enter", "\n": "enter", "\u007f": "backspace", "\u001b[A": "up", "\u001b[B": "down", "\u001b[C": "right", "\u001b[D": "left", "\u001b[5~": "pageup", "\u001b[6~": "pagedown", "\u001b": "escape", "\t": "tab" };
  const name = table[sequence];
  if (name) return { name, sequence };
  if (sequence === "\u0007") return { name: "g", sequence, ctrl: true };
  if (sequence === "\u0012") return { name: "r", sequence, ctrl: true };
  if (sequence === "\u0013") return { name: "s", sequence, ctrl: true };
  if (sequence.length === 2 && sequence[0] === "\u0003") return { name: "c", sequence, ctrl: true };
  if (sequence.length === 2 && sequence[0] === "\u000c") return { name: "l", sequence, ctrl: true };
  const result: KeyLike = { sequence };
  if (sequence.length === 1) result.name = sequence;
  return result;
}

export function applyText(state: RootState, value: string): RootState {
  if (state.focus === "Search") return reduce(state, { type: "set_search", value });
  return state;
}
