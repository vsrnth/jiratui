import { clampIndex, layoutFor, type Layout, type LayoutMode, type TerminalSize } from "./layout";
import { backspaceSecret, emptySecret, type SecretEditor } from "./secure-input";
import type { IssueDetail, IssueSummary } from "./protocol";

export type Focus = "Nav" | "Search" | "List" | "Detail" | "Composer" | "Picker" | "Settings" | "Help" | "EventLog";
export type Section = "issues" | "updates" | "team" | "settings";
export type ThemeMode = "System" | "Light" | "Dark";
export type Phase = "onboarding" | "loading" | "ready" | "error";

export type Onboarding = {
  baseUrl: string;
  email: string;
  token: SecretEditor;
  remember: boolean;
  field: "baseUrl" | "email" | "token" | "remember";
  error: string | null;
  submitting: boolean;
};

export type SafeEvent = { at: string; kind: string; message: string };
export type RootState = {
  phase: Phase;
  sessionId: string;
  section: Section;
  focus: Focus;
  size: TerminalSize;
  layout: Layout;
  theme: ThemeMode;
  detectedTheme: "Light" | "Dark" | null;
  siteLabel: string | null;
  identity: string | null;
  onboarding: Onboarding;
  issues: IssueSummary[];
  filteredIssues: IssueSummary[];
  search: string;
  lookupEditor: string;
  selectedIndex: number;
  selectedIssueKey: string | null;
  detail: IssueDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  refreshLoading: boolean;
  lastSource: "cache" | "jira" | null;
  lastRefresh: string | null;
  generations: { refresh: number; detail: number; lookup: number };
  overlays: { help: boolean; eventLog: boolean };
  confirmForgetLogin: boolean;
  scroll: { list: number; detail: number; updates: number; team: number; eventLog: number };
  events: SafeEvent[];
  lastMessage: string | null;
};

const session = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const event = (kind: string, message: string): SafeEvent => ({ at: new Date().toISOString(), kind, message });

export function initialState(size: TerminalSize = { width: 120, height: 40 }): RootState {
  return {
    phase: "onboarding", sessionId: session(), section: "issues", focus: "Nav", size, layout: layoutFor(size),
    theme: "System", detectedTheme: null, siteLabel: null, identity: null,
    onboarding: { baseUrl: "", email: "", token: emptySecret(), remember: true, field: "baseUrl", error: null, submitting: false },
    issues: [], filteredIssues: [], search: "", lookupEditor: "", selectedIndex: 0, selectedIssueKey: null,
    detail: null, detailLoading: false, detailError: null, refreshLoading: false, lastSource: null, lastRefresh: null,
    generations: { refresh: 0, detail: 0, lookup: 0 }, overlays: { help: false, eventLog: false }, confirmForgetLogin: false,
    scroll: { list: 0, detail: 0, updates: 0, team: 0, eventLog: 0 }, events: [], lastMessage: null,
  };
}

export type Action =
  | { type: "resize"; size: TerminalSize }
  | { type: "theme_mode"; mode: "Light" | "Dark" }
  | { type: "set_theme"; mode: ThemeMode }
  | { type: "set_focus"; focus: Focus }
  | { type: "set_section"; section: Section }
  | { type: "onboarding_text"; value: string }
  | { type: "onboarding_token"; value: string }
  | { type: "onboarding_backspace" }
  | { type: "onboarding_field"; field: Onboarding["field"] }
  | { type: "toggle_remember" }
  | { type: "onboarding_submit_start" }
  | { type: "onboarding_submit_clear" }
  | { type: "onboarding_error"; message: string }
  | { type: "authenticated"; siteLabel: string; identity: string }
  | { type: "workspace_snapshot"; siteLabel: string; identity: string; issues: readonly IssueSummary[]; source: "cache" | "jira"; refreshedAt: string; generation: number }
  | { type: "refresh_start" }
  | { type: "refresh_error"; message: string; generation: number }
  | { type: "detail_start"; issueKey: string }
  | { type: "detail_result"; issue: IssueDetail; issueKey: string; generation: number }
  | { type: "detail_error"; message: string; generation: number }
  | { type: "set_search"; value: string }
  | { type: "set_lookup"; value: string }
  | { type: "confirm_forget_login"; value: boolean }
  | { type: "move_selection"; delta: number }
  | { type: "select_issue"; index: number }
  | { type: "toggle_help" } | { type: "toggle_event_log" } | { type: "scroll"; delta: number }
  | { type: "message"; message: string; kind?: string };

function withEvent(state: RootState, kind: string, message: string): RootState {
  return { ...state, lastMessage: message, events: [...state.events, event(kind, message)].slice(-64) };
}

function filterIssues(issues: readonly IssueSummary[], search: string): IssueSummary[] {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return issues.slice();
  return issues.filter((issue) => [issue.key, issue.summary, issue.status, issue.priority, issue.assignee].some((value) => value.toLocaleLowerCase().includes(needle)));
}

export function reduce(state: RootState, action: Action): RootState {
  switch (action.type) {
    case "resize": {
      const layout = layoutFor(action.size);
      return { ...state, size: action.size, layout, selectedIndex: clampIndex(state.selectedIndex, state.filteredIssues.length) };
    }
    case "theme_mode": return { ...state, detectedTheme: action.mode };
    case "set_theme": return { ...state, theme: action.mode };
    case "set_focus": return { ...state, focus: action.focus };
    case "set_section": return { ...state, section: action.section, focus: action.section === "issues" ? "List" : action.section === "settings" ? "Settings" : "Nav" };
    case "onboarding_text": {
      const field = state.onboarding.field;
      if (field === "token" || field === "remember") return state;
      return { ...state, onboarding: { ...state.onboarding, [field]: action.value, error: null } };
    }
    case "onboarding_token": return { ...state, onboarding: { ...state.onboarding, token: { value: action.value, cursor: action.value.length }, error: null } };
    case "onboarding_backspace": return { ...state, onboarding: { ...state.onboarding, token: backspaceSecret(state.onboarding.token) } };
    case "onboarding_field": return { ...state, onboarding: { ...state.onboarding, field: action.field, error: null } };
    case "toggle_remember": return { ...state, onboarding: { ...state.onboarding, remember: !state.onboarding.remember } };
    case "onboarding_submit_start": return { ...state, onboarding: { ...state.onboarding, submitting: true, error: null } };
    case "onboarding_submit_clear": return { ...state, onboarding: { ...state.onboarding, token: emptySecret() } };
    case "onboarding_error": return { ...state, phase: "onboarding", onboarding: { ...state.onboarding, submitting: false, error: action.message } };
    case "authenticated": return withEvent({ ...state, phase: "loading", siteLabel: action.siteLabel, identity: action.identity }, "auth", "Authenticated");
    case "workspace_snapshot": {
      if (action.generation !== state.generations.refresh) return state;
      const filtered = filterIssues(action.issues, state.search);
      return withEvent({ ...state, phase: "ready", siteLabel: action.siteLabel, identity: action.identity, issues: [...action.issues], filteredIssues: filtered, selectedIndex: clampIndex(state.selectedIndex, filtered.length), selectedIssueKey: filtered[clampIndex(state.selectedIndex, filtered.length)]?.key ?? null, refreshLoading: false, lastSource: action.source, lastRefresh: action.refreshedAt }, "refresh", `Loaded ${filtered.length} issues from ${action.source}`);
    }
    case "refresh_start": return { ...state, refreshLoading: true, generations: { ...state.generations, refresh: state.generations.refresh + 1 } };
    case "refresh_error": return action.generation === state.generations.refresh ? withEvent({ ...state, refreshLoading: false }, "refresh", action.message) : state;
    case "detail_start": return { ...state, detailLoading: true, detailError: null, selectedIssueKey: action.issueKey, detail: null, generations: { ...state.generations, detail: state.generations.detail + 1 } };
    case "detail_result": return action.generation === state.generations.detail && action.issueKey === state.selectedIssueKey ? { ...state, detailLoading: false, detail: action.issue, detailError: null, scroll: { ...state.scroll, detail: 0 } } : state;
    case "detail_error": return action.generation === state.generations.detail ? withEvent({ ...state, detailLoading: false, detailError: action.message }, "detail", action.message) : state;
    case "set_search": {
      const filtered = filterIssues(state.issues, action.value);
      const index = clampIndex(state.selectedIndex, filtered.length);
      return { ...state, search: action.value, filteredIssues: filtered, selectedIndex: index, selectedIssueKey: filtered[index]?.key ?? null };
    }
    case "set_lookup": return { ...state, lookupEditor: action.value };
    case "confirm_forget_login": return { ...state, confirmForgetLogin: action.value };
    case "move_selection": {
      if (!state.filteredIssues.length) return state;
      const index = clampIndex(state.selectedIndex + action.delta, state.filteredIssues.length);
      return { ...state, selectedIndex: index, selectedIssueKey: state.filteredIssues[index]?.key ?? null, scroll: { ...state.scroll, list: Math.max(0, index - 5) } };
    }
    case "select_issue": {
      const index = clampIndex(action.index, state.filteredIssues.length);
      return { ...state, selectedIndex: index, selectedIssueKey: state.filteredIssues[index]?.key ?? null };
    }
    case "toggle_help": return { ...state, overlays: { ...state.overlays, help: !state.overlays.help }, focus: state.overlays.help ? "List" : "Help" };
    case "toggle_event_log": return { ...state, overlays: { ...state.overlays, eventLog: !state.overlays.eventLog }, focus: state.overlays.eventLog ? "List" : "EventLog" };
    case "scroll": return { ...state, scroll: { ...state.scroll, [state.focus === "Detail" ? "detail" : state.overlays.eventLog ? "eventLog" : "list"]: Math.max(0, state.scroll[state.focus === "Detail" ? "detail" : state.overlays.eventLog ? "eventLog" : "list"] + action.delta) } };
    case "message": return withEvent(state, action.kind ?? "info", action.message);
  }
}

export function nextGeneration(state: RootState, operation: "refresh" | "detail" | "lookup"): [RootState, number] {
  const generation = state.generations[operation] + 1;
  return [{ ...state, generations: { ...state.generations, [operation]: generation } }, generation];
}

export type { LayoutMode };
