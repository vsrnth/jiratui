import { clampIndex, layoutFor, type Layout, type LayoutMode, type TerminalSize } from "./layout";
import { backspaceSecret, emptySecret, type SecretEditor } from "./secure-input";
import type { IssueDetail, IssueSummary, StatusCategory } from "./protocol";
import { emptyUpdateLedger, markAllDisplayedRead, setGroupExpanded, toggleGroupRead, updateGroups, type UpdateFilter, type UpdateGroup, type UpdateLedger } from "./updates/ledger";
import type { IssueId } from "./domain";

export type Focus = "Nav" | "Search" | "List" | "Detail" | "Composer" | "Picker" | "Settings" | "Help" | "EventLog";
export type Section = "issues" | "updates" | "team" | "settings";
export type ThemeMode = "System" | "Light" | "Dark";
/** Structural preference values shared with the backend without coupling state to storage. */
export type AppearancePreferences = Readonly<{
  theme: ThemeMode;
  noColor: boolean;
  asciiOnly: boolean;
}>;
export type SettingsPreferences = AppearancePreferences & Readonly<{
  jqlScope?: string;
  teamMembers?: readonly string[];
}>;
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
  activeAppearance: AppearancePreferences;
  draftAppearance: AppearancePreferences;
  /** Settings row: 0 scope, 1 theme, 2 no-color, 3 ASCII-only. */
  settingsRow: number;
  appearanceDirty: boolean;
  jqlScope: string | null;
  scopeDraft: string;
  scopeEditing: boolean;
  scopeSaving: boolean;
  scopeError: string | null;
  teamMemberCount: number;
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
  updates: UpdateLedger;
  updatesBaselineEstablished: boolean;
  updateFilter: UpdateFilter;
  selectedUpdateIndex: number;
  selectedUpdateIssueId: IssueId | null;
  confirmMarkAllUpdates: boolean;
  generations: { connect: number; refresh: number; detail: number; lookup: number; scope: number };
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
    theme: "System", detectedTheme: null,
    activeAppearance: { theme: "System", noColor: false, asciiOnly: false },
    draftAppearance: { theme: "System", noColor: false, asciiOnly: false },
    settingsRow: 0, appearanceDirty: false, jqlScope: null, scopeDraft: "", scopeEditing: false, scopeSaving: false, scopeError: null, teamMemberCount: 0,
    siteLabel: null, identity: null,
    onboarding: { baseUrl: "", email: "", token: emptySecret(), remember: true, field: "baseUrl", error: null, submitting: false },
    issues: [], filteredIssues: [], search: "", statusFilter: [], statusDraft: [], statusPickerIndex: 0, pickerMode: null, lookupEditor: "", selectedIndex: 0, selectedIssueKey: null,
    detail: null, detailLoading: false, detailError: null, refreshLoading: false, lastSource: null, lastRefresh: null,
    updates: emptyUpdateLedger(), updatesBaselineEstablished: false, updateFilter: "unread", selectedUpdateIndex: 0, selectedUpdateIssueId: null, confirmMarkAllUpdates: false,
    generations: { connect: 0, refresh: 0, detail: 0, lookup: 0, scope: 0 }, overlays: { help: false, eventLog: false }, confirmForgetLogin: false,
    scroll: { list: 0, detail: 0, updates: 0, team: 0, eventLog: 0 }, events: [], lastMessage: null,
  };
}

export type Action =
  | { type: "resize"; size: TerminalSize }
  | { type: "theme_mode"; mode: "Light" | "Dark" }
  | { type: "set_theme"; mode: ThemeMode }
  | { type: "preferences_loaded"; preferences: SettingsPreferences }
  | { type: "settings_move"; delta: number }
  | { type: "appearance_cycle" }
  | { type: "appearance_saved"; preferences: SettingsPreferences }
  | { type: "appearance_save_failed"; message?: string }
  | { type: "appearance_reload_failed"; message?: string }
  | { type: "appearance_restore" }
  | { type: "scope_edit_start" }
  | { type: "scope_edit_cancel" }
  | { type: "scope_edit_insert"; value: string }
  | { type: "scope_edit_backspace" }
  | { type: "scope_restore" }
  | { type: "scope_save_start" }
  | { type: "scope_save_cancel" }
  | { type: "scope_save_succeeded"; preferences: SettingsPreferences; snapshot: ScopeSnapshot; generation: number }
  | { type: "scope_save_failed"; message: string; generation: number }
  | { type: "set_focus"; focus: Focus }
  | { type: "set_section"; section: Section }
  | { type: "onboarding_text"; value: string }
  | { type: "onboarding_token"; value: string }
  | { type: "onboarding_backspace" }
  | { type: "onboarding_field"; field: Onboarding["field"] }
  | { type: "toggle_remember" }
  | { type: "onboarding_submit_start" }
  | { type: "onboarding_submit_clear" }
  | { type: "onboarding_clear_token" }
  | { type: "onboarding_cancel" }
  | { type: "onboarding_error"; message: string; generation?: number }
  | { type: "authenticated"; siteLabel: string; identity: string; generation?: number }
  | { type: "workspace_snapshot"; siteLabel: string; identity: string; issues: readonly IssueSummary[]; source: "cache" | "jira"; refreshedAt: string; generation: number; updates: UpdateLedger; updatesBaselineEstablished: boolean }
  | { type: "updates_persisted"; updates: UpdateLedger }
  | { type: "refresh_start" }
  | { type: "refresh_cancel" }
  | { type: "refresh_error"; message: string; generation: number }
  | { type: "detail_start"; issueKey: string }
  | { type: "detail_cancel" }
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
  | { type: "toggle_update_filter" }
  | { type: "move_update_selection"; delta: number }
  | { type: "toggle_update_read" }
  | { type: "toggle_update_expanded" }
  | { type: "request_mark_all_updates" }
  | { type: "confirm_mark_all_updates"; value: boolean }
  | { type: "select_update_issue" }
  | { type: "toggle_help" } | { type: "toggle_event_log" } | { type: "scroll"; delta: number }
  | { type: "message"; message: string; kind?: string };

/** Renderer-neutral snapshot returned when applying a Jira scope. */
export type ScopeSnapshot = Readonly<{
  siteLabel: string;
  identity: string;
  issues: readonly IssueSummary[];
  source: "cache" | "jira";
  refreshedAt: string;
  updates: UpdateLedger;
  updatesBaselineEstablished: boolean;
}>;

export const MAX_JQL_SCOPE_BYTES = 2_000;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasControlCharacter(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function scopeValue(value: string): string {
  return value.trim();
}

function validScopeEdit(current: string, value: string): boolean {
  return value.length > 0 && !hasControlCharacter(value) && utf8Bytes(current + value) <= MAX_JQL_SCOPE_BYTES;
}

function withSettingsRow(state: RootState, row: number): RootState {
  const next = clampIndex(row, 4);
  return { ...state, settingsRow: next };
}

function withEvent(state: RootState, kind: string, message: string): RootState {
  return { ...state, lastMessage: message, events: [...state.events, event(kind, message)].slice(-64) };
}

function appearanceFrom(preferences: SettingsPreferences): AppearancePreferences {
  return { theme: preferences.theme, noColor: preferences.noColor, asciiOnly: preferences.asciiOnly };
}

function sameAppearance(left: AppearancePreferences, right: AppearancePreferences): boolean {
  return left.theme === right.theme && left.noColor === right.noColor && left.asciiOnly === right.asciiOnly;
}

function withAppearance(state: RootState, draft: AppearancePreferences): RootState {
  return { ...state, theme: draft.theme, draftAppearance: draft, appearanceDirty: !sameAppearance(draft, state.activeAppearance) };
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

export function visibleUpdateGroups(state: RootState): UpdateGroup[] {
  return updateGroups(state.updates, state.updateFilter);
}

function selectedUpdate(state: RootState, groups: readonly UpdateGroup[]): RootState {
  const previousId = state.selectedUpdateIssueId;
  const preservedIndex = previousId ? groups.findIndex((group) => String(group.issueId) === String(previousId)) : -1;
  const index = preservedIndex >= 0 ? preservedIndex : clampIndex(state.selectedUpdateIndex, groups.length);
  const selectedUpdateIssueId = groups[index]?.issueId ?? null;
  return { ...state, selectedUpdateIndex: index, selectedUpdateIssueId, scroll: { ...state.scroll, updates: Math.max(0, index - 5) } };
}

export function reduce(state: RootState, action: Action): RootState {
  switch (action.type) {
    case "resize": {
      const layout = layoutFor(action.size);
      return { ...state, size: action.size, layout, selectedIndex: clampIndex(state.selectedIndex, state.filteredIssues.length) };
    }
    case "theme_mode": return { ...state, detectedTheme: action.mode };
    case "set_theme": return withAppearance(state, { ...state.draftAppearance, theme: action.mode });
    case "preferences_loaded": {
      const appearance = appearanceFrom(action.preferences);
      const activeScope = scopeValue(action.preferences.jqlScope ?? "");
      return {
        ...state,
        theme: appearance.theme,
        activeAppearance: appearance,
        draftAppearance: appearance,
        appearanceDirty: false,
        jqlScope: activeScope || null,
        scopeDraft: state.scopeEditing || state.scopeSaving ? state.scopeDraft : activeScope,
        scopeError: null,
        teamMemberCount: action.preferences.teamMembers?.length ?? 0,
      };
    }
    case "settings_move": return state.scopeSaving ? state : withSettingsRow(state, state.settingsRow + action.delta);
    case "appearance_cycle": {
      if (state.scopeSaving || state.scopeEditing || state.settingsRow === 0) return state;
      const row = state.settingsRow;
      if (row === 1) {
        const modes: ThemeMode[] = ["System", "Light", "Dark"];
        const index = Math.max(0, modes.indexOf(state.draftAppearance.theme));
        return withAppearance(state, { ...state.draftAppearance, theme: modes[(index + 1) % modes.length] ?? "System" });
      }
      if (row === 2) return withAppearance(state, { ...state.draftAppearance, noColor: !state.draftAppearance.noColor });
      return withAppearance(state, { ...state.draftAppearance, asciiOnly: !state.draftAppearance.asciiOnly });
    }
    case "appearance_saved": {
      const appearance = appearanceFrom(action.preferences);
      return {
        ...state,
        theme: appearance.theme,
        activeAppearance: appearance,
        draftAppearance: appearance,
        appearanceDirty: false,
        jqlScope: scopeValue(action.preferences.jqlScope ?? "") || null,
        scopeDraft: state.scopeEditing || state.scopeSaving ? state.scopeDraft : scopeValue(action.preferences.jqlScope ?? ""),
        scopeError: null,
        teamMemberCount: action.preferences.teamMembers?.length ?? 0,
      };
    }
    case "appearance_save_failed": return withEvent(state, "settings", action.message ?? "Appearance could not be saved; changes remain local");
    case "appearance_reload_failed": return withEvent(state, "settings", action.message ?? "Preferences could not be reloaded; changes remain local");
    case "appearance_restore": return state.settingsRow === 0 ? state : withAppearance(state, state.activeAppearance);
    case "scope_edit_start":
      return state.scopeSaving ? state : { ...state, settingsRow: 0, scopeEditing: true, scopeError: null, scopeDraft: state.jqlScope ?? "" };
    case "scope_edit_cancel": return state.scopeSaving ? state : { ...state, scopeEditing: false, scopeError: null };
    case "scope_edit_insert": {
      if (!state.scopeEditing || state.scopeSaving || !validScopeEdit(state.scopeDraft, action.value)) return state;
      return { ...state, scopeDraft: state.scopeDraft + action.value, scopeError: null };
    }
    case "scope_edit_backspace": {
      if (!state.scopeEditing || state.scopeSaving || state.scopeDraft.length === 0) return state;
      const chars = Array.from(state.scopeDraft);
      chars.pop();
      return { ...state, scopeDraft: chars.join(""), scopeError: null };
    }
    case "scope_restore": return state.scopeSaving ? state : { ...state, scopeDraft: state.jqlScope ?? "", scopeError: null };
    case "scope_save_start":
      return state.scopeSaving ? state : { ...state, scopeEditing: true, scopeSaving: true, scopeError: null, generations: { ...state.generations, scope: state.generations.scope + 1 } };
    case "scope_save_cancel":
      return state.scopeSaving
        ? withEvent({ ...state, scopeSaving: false, scopeEditing: true, generations: { ...state.generations, scope: state.generations.scope + 1 } }, "settings", "Jira scope save cancelled")
        : state;
    case "scope_save_succeeded": {
      if (!state.scopeSaving || action.generation !== state.generations.scope) return state;
      const appearance = appearanceFrom(action.preferences);
      const activeScope = scopeValue(action.preferences.jqlScope ?? "");
      const refreshed = reduce({
        ...state,
        theme: appearance.theme,
        activeAppearance: appearance,
        draftAppearance: appearance,
        appearanceDirty: false,
        jqlScope: activeScope || null,
        scopeDraft: activeScope,
        scopeEditing: false,
        scopeSaving: false,
        scopeError: null,
        teamMemberCount: action.preferences.teamMembers?.length ?? 0,
      }, {
        type: "workspace_snapshot",
        siteLabel: action.snapshot.siteLabel,
        identity: action.snapshot.identity,
        issues: action.snapshot.issues,
        source: action.snapshot.source,
        refreshedAt: action.snapshot.refreshedAt,
        generation: state.generations.refresh,
        updates: action.snapshot.updates,
        updatesBaselineEstablished: action.snapshot.updatesBaselineEstablished,
      });
      return withEvent(refreshed, "settings", "Jira scope saved");
    }
    case "scope_save_failed":
      return !state.scopeSaving || action.generation !== state.generations.scope
        ? state
        : withEvent({ ...state, scopeSaving: false, scopeEditing: true, scopeError: action.message.slice(0, 240) }, "settings", action.message.slice(0, 240));
    case "set_focus": return { ...state, focus: action.focus };
    case "set_section": return { ...state, section: action.section, focus: action.section === "issues" || action.section === "updates" ? "List" : action.section === "settings" ? "Settings" : "Nav" };
    case "onboarding_text": {
      const field = state.onboarding.field;
      if (field === "token" || field === "remember") return state;
      return { ...state, onboarding: { ...state.onboarding, [field]: action.value, error: null } };
    }
    case "onboarding_token": return { ...state, onboarding: { ...state.onboarding, token: { value: action.value, cursor: action.value.length }, error: null } };
    case "onboarding_backspace": return { ...state, onboarding: { ...state.onboarding, token: backspaceSecret(state.onboarding.token) } };
    case "onboarding_field": return { ...state, onboarding: { ...state.onboarding, field: action.field, error: null } };
    case "toggle_remember": return { ...state, onboarding: { ...state.onboarding, remember: !state.onboarding.remember } };
    case "onboarding_submit_start": return state.onboarding.submitting ? state : { ...state, onboarding: { ...state.onboarding, submitting: true, error: null }, generations: { ...state.generations, connect: state.generations.connect + 1 } };
    case "onboarding_submit_clear": return { ...state, onboarding: { ...state.onboarding, token: emptySecret() } };
    case "onboarding_clear_token": return { ...state, onboarding: { ...state.onboarding, token: emptySecret(), error: null } };
    case "onboarding_cancel": return withEvent({ ...state, phase: "onboarding", onboarding: { ...state.onboarding, token: emptySecret(), field: "token", submitting: false, error: null }, generations: { ...state.generations, connect: state.generations.connect + 1 } }, "connect", "Connection cancelled");
    case "onboarding_error": {
      if (action.generation !== undefined && action.generation !== state.generations.connect) return state;
      return { ...state, phase: "onboarding", onboarding: { ...state.onboarding, token: emptySecret(), field: "token", submitting: false, error: action.message } };
    }
    case "authenticated": {
      if (action.generation !== undefined && action.generation !== state.generations.connect) return state;
      return withEvent({
        ...state,
        phase: "loading",
        siteLabel: action.siteLabel,
        identity: action.identity,
        issues: [],
        filteredIssues: [],
        selectedIndex: 0,
        selectedIssueKey: null,
        detail: null,
        detailLoading: false,
        detailError: null,
        lastSource: null,
        lastRefresh: null,
        updates: emptyUpdateLedger(),
        updatesBaselineEstablished: false,
        selectedUpdateIndex: 0,
        selectedUpdateIssueId: null,
        confirmMarkAllUpdates: false,
        onboarding: { ...state.onboarding, token: emptySecret(), submitting: false, error: null },
        generations: { ...state.generations, refresh: state.generations.refresh + 1, detail: state.generations.detail + 1 },
      }, "auth", "Authenticated");
    }
    case "workspace_snapshot": {
      if (action.generation !== state.generations.refresh) return state;
      const filtered = filterIssues(action.issues, state.search, state.statusFilter);
      const next = { ...state, phase: "ready" as const, siteLabel: action.siteLabel, identity: action.identity, issues: [...action.issues], refreshLoading: false, lastSource: action.source, lastRefresh: action.refreshedAt, updates: action.updates, updatesBaselineEstablished: action.updatesBaselineEstablished, confirmMarkAllUpdates: false };
      return withEvent(selectedUpdate(selectedIssue(next, filtered), visibleUpdateGroups(next)), "refresh", `Loaded ${filtered.length} issues from ${action.source}`);
    }
    case "updates_persisted": return { ...state, updates: action.updates };
    case "refresh_start": return { ...state, refreshLoading: true, generations: { ...state.generations, refresh: state.generations.refresh + 1 } };
    case "refresh_cancel": return { ...state, refreshLoading: false, generations: { ...state.generations, refresh: state.generations.refresh + 1 } };
    case "refresh_error": return action.generation === state.generations.refresh ? withEvent({ ...state, refreshLoading: false }, "refresh", action.message) : state;
    case "detail_start": return { ...state, detailLoading: true, detailError: null, selectedIssueKey: action.issueKey, detail: null, generations: { ...state.generations, detail: state.generations.detail + 1 } };
    case "detail_cancel": return { ...state, detailLoading: false, detail: null, detailError: null, generations: { ...state.generations, detail: state.generations.detail + 1 } };
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
    case "toggle_update_filter": {
      const updateFilter: UpdateFilter = state.updateFilter === "unread" ? "all" : "unread";
      return selectedUpdate({ ...state, updateFilter }, updateGroups(state.updates, updateFilter));
    }
    case "move_update_selection": {
      const groups = visibleUpdateGroups(state);
      if (groups.length === 0) return state;
      const index = clampIndex(state.selectedUpdateIndex + action.delta, groups.length);
      return { ...state, selectedUpdateIndex: index, selectedUpdateIssueId: groups[index]?.issueId ?? null, scroll: { ...state.scroll, updates: Math.max(0, index - 5) } };
    }
    case "toggle_update_read": {
      const groups = visibleUpdateGroups(state);
      const group = groups[state.selectedUpdateIndex];
      if (!group) return state;
      const nextState = withEvent({ ...state, updates: toggleGroupRead(state.updates, group.issueId, state.issues.map((issue) => issue.id)) }, "updates", `${group.unread ? "Marked read" : "Marked unread"}: ${group.issueKey}`);
      return selectedUpdate(nextState, visibleUpdateGroups(nextState));
    }
    case "toggle_update_expanded": {
      const groups = visibleUpdateGroups(state);
      const group = groups[state.selectedUpdateIndex];
      if (!group) return state;
      return selectedUpdate({ ...state, updates: setGroupExpanded(state.updates, group.issueId, !group.expanded) }, groups);
    }
    case "request_mark_all_updates": {
      const groups = visibleUpdateGroups(state);
      const affected = groups.filter((group) => group.unread);
      if (affected.length === 0) return withEvent(state, "updates", "No unread updates to mark read");
      if (affected.length > 1) return { ...state, confirmMarkAllUpdates: true };
      const nextState = withEvent({ ...state, updates: markAllDisplayedRead(state.updates, groups.map((group) => group.issueId), state.issues.map((issue) => issue.id)) }, "updates", "Marked 1 update read");
      return selectedUpdate(nextState, visibleUpdateGroups(nextState));
    }
    case "confirm_mark_all_updates": {
      if (!action.value) return { ...state, confirmMarkAllUpdates: false };
      const groups = visibleUpdateGroups(state);
      const affected = groups.filter((group) => group.unread);
      if (affected.length === 0) return { ...state, confirmMarkAllUpdates: false };
      const nextState = withEvent({ ...state, confirmMarkAllUpdates: false, updates: markAllDisplayedRead(state.updates, groups.map((group) => group.issueId), state.issues.map((issue) => issue.id)) }, "updates", `Marked ${affected.length} updates read`);
      return selectedUpdate(nextState, visibleUpdateGroups(nextState));
    }
    case "select_update_issue": {
      const groups = visibleUpdateGroups(state);
      const group = groups[state.selectedUpdateIndex];
      if (!group) return state;
      const issueIndex = state.filteredIssues.findIndex((issue) => String(issue.id) === String(group.issueId));
      return { ...state, section: "issues", focus: "Detail", selectedIssueKey: group.issueKey, selectedIndex: issueIndex >= 0 ? issueIndex : state.selectedIndex };
    }
    case "toggle_help": return { ...state, overlays: { ...state.overlays, help: !state.overlays.help }, focus: state.overlays.help ? "List" : "Help" };
    case "toggle_event_log": return { ...state, overlays: { ...state.overlays, eventLog: !state.overlays.eventLog }, focus: state.overlays.eventLog ? "List" : "EventLog" };
    case "scroll": {
      const key = state.focus === "Detail" ? "detail" : state.overlays.eventLog ? "eventLog" : state.section === "updates" ? "updates" : "list";
      return { ...state, scroll: { ...state.scroll, [key]: Math.max(0, state.scroll[key] + action.delta) } };
    }
    case "message": return withEvent(state, action.kind ?? "info", action.message);
  }
}

export function nextGeneration(state: RootState, operation: "refresh" | "detail" | "lookup"): [RootState, number] {
  const generation = state.generations[operation] + 1;
  return [{ ...state, generations: { ...state.generations, [operation]: generation } }, generation];
}

export type { LayoutMode };
