import { clampIndex, layoutFor, type Layout, type LayoutMode, type TerminalSize } from "./layout";
import { backspaceSecret, emptySecret, type SecretEditor } from "./secure-input";
import type { IssueDetail, IssueSummary, StatusCategory } from "./protocol";

export type Focus = "Nav" | "Search" | "List" | "Detail" | "Composer" | "Picker" | "Settings" | "Help" | "EventLog";
export type Section = "issues" | "updates" | "team" | "settings";
export type ThemeMode = "System" | "Light" | "Dark";
export type Phase = "onboarding" | "loading" | "ready" | "error";
export type PickerMode = "lookup" | "status" | null;

export const STATUS_CATEGORIES: readonly StatusCategory[] = ["to_do", "in_progress", "done", "uncategorized"];

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
  statusFilter: StatusCategory[];
  statusDraft: StatusCategory[];
  statusPickerIndex: number;
  pickerMode: PickerMode;
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
    issues: [], filteredIssues: [], search: "", statusFilter: [], statusDraft: [], statusPickerIndex: 0, pickerMode: null, lookupEditor: "", selectedIndex: 0, selectedIssueKey: null,
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
  | { type: "open_status_picker" }
  | { type: "move_status_picker"; delta: number }
  | { type: "toggle_status_draft" }
  | { type: "apply_status_filter" }
  | { type: "cancel_status_filter" }
  | { type: "set_lookup"; value: string }
  | { type: "confirm_forget_login"; value: boolean }
  | { type: "move_selection"; delta: number }
  | { type: "select_issue"; index: number }
  | { type: "toggle_help" } | { type: "toggle_event_log" } | { type: "scroll"; delta: number }
  | { type: "message"; message: string; kind?: string };

function withEvent(state: RootState, kind: string, message: string): RootState {
  return { ...state, lastMessage: message, events: [...state.events, event(kind, message)].slice(-64) };
}

function filterIssues(issues: readonly IssueSummary[], search: string, statusFilter: readonly StatusCategory[] = []): IssueSummary[] {
  const needle = search.trim().toLocaleLowerCase();
  return issues.filter((issue) => {
    const matchesSearch = !needle || [issue.key, issue.summary, issue.status, issue.priority, issue.assignee].some((value) => value.toLocaleLowerCase().includes(needle));
    const matchesStatus = statusFilter.length === 0 || statusFilter.includes(issue.statusCategory);
    return matchesSearch && matchesStatus;
  });
}

function selectedIssue(state: RootState, filtered: readonly IssueSummary[]): RootState {
  const previousKey = state.selectedIssueKey;
  const preservedIndex = previousKey ? filtered.findIndex((issue) => issue.key === previousKey) : -1;
  const index = preservedIndex >= 0 ? preservedIndex : 0;
  const selectedIssueKey = filtered[index]?.key ?? null;
  if (selectedIssueKey === previousKey) return { ...state, filteredIssues: [...filtered], selectedIndex: index, selectedIssueKey };
  const hasDetailOperation = state.detail !== null || state.detailLoading || state.detailError !== null;
  return {
    ...state,
    filteredIssues: [...filtered],
    selectedIndex: index,
    selectedIssueKey,
    detail: null,
    detailLoading: false,
    detailError: null,
    generations: hasDetailOperation ? { ...state.generations, detail: state.generations.detail + 1 } : state.generations,
  };
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
      const filtered = filterIssues(action.issues, state.search, state.statusFilter);
      return withEvent(selectedIssue({ ...state, phase: "ready", siteLabel: action.siteLabel, identity: action.identity, issues: [...action.issues], refreshLoading: false, lastSource: action.source, lastRefresh: action.refreshedAt }, filtered), "refresh", `Loaded ${filtered.length} issues from ${action.source}`);
    }
    case "refresh_start": return { ...state, refreshLoading: true, generations: { ...state.generations, refresh: state.generations.refresh + 1 } };
    case "refresh_error": return action.generation === state.generations.refresh ? withEvent({ ...state, refreshLoading: false }, "refresh", action.message) : state;
    case "detail_start": return { ...state, detailLoading: true, detailError: null, selectedIssueKey: action.issueKey, detail: null, generations: { ...state.generations, detail: state.generations.detail + 1 } };
    case "detail_result": return action.generation === state.generations.detail && action.issueKey === state.selectedIssueKey ? { ...state, detailLoading: false, detail: action.issue, detailError: null, scroll: { ...state.scroll, detail: 0 } } : state;
    case "detail_error": return action.generation === state.generations.detail ? withEvent({ ...state, detailLoading: false, detailError: action.message }, "detail", action.message) : state;
    case "set_search": {
      const filtered = filterIssues(state.issues, action.value, state.statusFilter);
      return selectedIssue({ ...state, search: action.value }, filtered);
    }
    case "open_status_picker": return { ...state, focus: "Picker", pickerMode: "status", statusDraft: [...state.statusFilter], statusPickerIndex: 0 };
    case "move_status_picker": {
      const index = clampIndex(state.statusPickerIndex + action.delta, STATUS_CATEGORIES.length);
      return { ...state, statusPickerIndex: index };
    }
    case "toggle_status_draft": {
      const category = STATUS_CATEGORIES[state.statusPickerIndex];
      if (!category) return state;
      const draft = state.statusDraft.includes(category) ? state.statusDraft.filter((item) => item !== category) : [...state.statusDraft, category];
      return { ...state, statusDraft: draft };
    }
    case "apply_status_filter": {
      const statusFilter = [...state.statusDraft];
      const filtered = filterIssues(state.issues, state.search, statusFilter);
      return selectedIssue({ ...state, statusFilter, statusDraft: [...statusFilter], pickerMode: null, focus: "List" }, filtered);
    }
    case "cancel_status_filter": return { ...state, statusDraft: [...state.statusFilter], pickerMode: null, focus: "List" };
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
