import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import { maskedSecret } from "../secure-input";
import { MAX_JQL_SCOPE_BYTES, MAX_TEAM_MEMBERS_BYTES, STATUS_CATEGORIES, visibleUpdateGroups, type RootState } from "../state";
import type { StatusCategory } from "../protocol";
import { GENERIC_UPDATE_LABEL, type UpdateEvent } from "../updates/ledger";

export type Palette = Readonly<{
  fg?: string; dim?: string; accent?: string; blue?: string; warn?: string; error?: string;
  bg?: string; panel?: string; selected?: string; border?: string;
}>;

const DARK_PALETTE: Palette = Object.freeze({ fg: "#e6e1d6", dim: "#9b978d", accent: "#7dd3a3", blue: "#8ab4f8", warn: "#f2c97d", error: "#f28b82", bg: "#171817", panel: "#20221f", selected: "#2d3d35", border: "#59635b" });
const LIGHT_PALETTE: Palette = Object.freeze({ fg: "#1f2937", dim: "#4b5563", accent: "#087f5b", blue: "#1d4ed8", warn: "#92400e", error: "#b91c1c", bg: "#ffffff", panel: "#f3f4f6", selected: "#d1fae5", border: "#6b7280" });
const NO_COLOR_PALETTE: Palette = Object.freeze({});
export const ASCII_BORDER_CHARS = Object.freeze({ topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|", topT: "+", bottomT: "+", leftT: "+", rightT: "+", cross: "+" });

/** Pure palette resolution, useful to test theme behavior without a renderer. */
export function paletteFor(theme: RootState["theme"], detectedTheme: RootState["detectedTheme"], noColor = false): Palette {
  if (noColor) return NO_COLOR_PALETTE;
  return (theme === "System" ? (detectedTheme ?? "Dark") : theme) === "Light" ? LIGHT_PALETTE : DARK_PALETTE;
}

let activePalette: Palette = DARK_PALETTE;
let activeAsciiOnly = false;
const C = new Proxy({} as Palette, { get: (_target, key: string): string | undefined => activePalette[key as keyof Palette] });

type Context = CliRenderer;
type Style = ConstructorParameters<typeof BoxRenderable>[1];
type ScrollStyle = ConstructorParameters<typeof ScrollBoxRenderable>[1];
type TextStyle = ConstructorParameters<typeof TextRenderable>[1];
type LooseStyle<T extends object> = { [K in keyof T]?: T[K] | undefined } & Record<string, unknown>;
type BoxInput = LooseStyle<Style>;
type ScrollInput = LooseStyle<ScrollStyle>;
type TextInput = LooseStyle<TextStyle>;

function styledOptions<T extends Record<string, unknown>>(options: T): Record<string, unknown> {
  const { fg, bg, backgroundColor, borderColor, titleColor, focusedBorderColor, ...rest } = options;
  return {
    ...rest,
    ...(fg === undefined ? {} : { fg }),
    ...(bg === undefined ? {} : { bg }),
    ...(backgroundColor === undefined ? {} : { backgroundColor }),
    ...(borderColor === undefined ? {} : { borderColor }),
    ...(titleColor === undefined ? {} : { titleColor }),
    ...(focusedBorderColor === undefined ? {} : { focusedBorderColor }),
  } as T;
}
function borderOptions(options: Record<string, unknown>): Record<string, unknown> {
  return activeAsciiOnly ? { ...options, customBorderChars: ASCII_BORDER_CHARS } : options;
}
function box(ctx: Context, options: BoxInput = {}): BoxRenderable {
  return new BoxRenderable(ctx, borderOptions(styledOptions({ flexDirection: "column", flexShrink: 0, ...options })) as Style);
}
function scrollBox(ctx: Context, options: ScrollInput = {}): ScrollBoxRenderable {
  const scroll = new ScrollBoxRenderable(ctx, borderOptions(styledOptions(options)) as ScrollStyle);
  // Keep scrolling stateful and keyboard-accessible, but leave scrollbar
  // chrome out of the frame. OpenTUI otherwise briefly paints a native thumb
  // when selection changes or content is measured.
  scroll.verticalScrollBar.visible = false;
  scroll.horizontalScrollBar.visible = false;
  return scroll;
}
function text(ctx: Context, content: string, options: TextInput = {}): TextRenderable {
  return new TextRenderable(ctx, styledOptions({ content, flexShrink: 0, ...options }) as TextStyle);
}
function appGlyphs(content: string): string {
  if (!activeAsciiOnly) return content;
  return content.replaceAll("▸", ">").replaceAll("●", "*").replaceAll("○", "o").replaceAll("▾", "v").replaceAll("…", "...").replaceAll("•", "*").replaceAll("→", "->").replaceAll("·", ".").replaceAll("“", '"').replaceAll("”", '"').replaceAll("↑", "^").replaceAll("↓", "v").replaceAll("←", "<");
}
function appText(ctx: Context, content: string, options: TextInput = {}): TextRenderable {
  return text(ctx, appGlyphs(content), options);
}
function add(parent: Renderable, child: Renderable): void { parent.add(child); }

function statusCategoryLabel(category: StatusCategory): string {
  return category === "to_do" ? "To Do" : category === "in_progress" ? "In Progress" : category === "done" ? "Done" : "Uncategorized";
}

function statusFilterLabel(filter: readonly StatusCategory[]): string {
  if (filter.length === 0) return "All";
  if (filter.length === 1 && filter[0]) return statusCategoryLabel(filter[0]);
  return `${filter.length} statuses`;
}

function uiSeparator(): string { return activeAsciiOnly ? "." : "·"; }

function clearRoot(renderer: Context): void {
  for (const child of renderer.root.getChildren()) child.destroyRecursively();
}

function titleBar(ctx: Context, state: RootState): BoxRenderable {
  const header = box(ctx, { width: "100%", height: 2, backgroundColor: C.panel, paddingLeft: 1, paddingRight: 1, flexDirection: "row", alignItems: "center" });
  add(header, text(ctx, "JIRA DESK", { fg: C.accent, width: 12 }));
  add(header, text(ctx, state.siteLabel ? `${state.siteLabel} ${uiSeparator()} ${state.identity ?? ""}` : "Read-only Jira workspace", { fg: C.dim, flexGrow: 1, width: "auto" }));
  add(header, text(ctx, state.theme === "System" ? `System/${state.detectedTheme ?? "?"}` : state.theme, { fg: C.dim, width: 18 }));
  return header;
}

function footer(ctx: Context, state: RootState): BoxRenderable {
  const footer = box(ctx, { width: "100%", height: 2, backgroundColor: C.panel, paddingLeft: 1, flexDirection: "row", alignItems: "center" });
  add(footer, text(ctx, state.lastMessage ?? (state.focus === "Detail" ? "? Help   j/k Scroll   PgUp/PgDn Page   Home/End Bounds   b/Esc Back to list" : state.section === "team" ? "? Help   j/k Select   r Refresh Team   Enter Remote detail   4 Settings   q Quit" : "? Help   e Events   / Search   s Status filter   l Lookup   r Refresh   Enter Detail   q Quit"), { fg: state.lastMessage ? C.accent : C.dim, flexGrow: 1, width: "auto" }));
  add(footer, appText(ctx, `${state.focus} · ${state.layout.mode}`, { fg: C.dim, width: 24 }));
  return footer;
}

function onboarding(ctx: Context, state: RootState): BoxRenderable {
  const panel = box(ctx, { width: "100%", height: "100%", padding: 2, border: true, borderColor: C.border, title: " CONNECT TO JIRA (read-only) " });
  add(panel, text(ctx, "Credentials stay in the private backend and are never logged or rendered.", { fg: C.dim }));
  const fields: Array<[string, string, boolean]> = [["Jira HTTPS URL", state.onboarding.baseUrl, state.onboarding.field === "baseUrl"], ["Atlassian email", state.onboarding.email, state.onboarding.field === "email"], ["Scoped API token", maskedSecret(state.onboarding.token), state.onboarding.field === "token"], ["Remember securely", state.onboarding.remember ? "[x]" : "[ ]", state.onboarding.field === "remember"]];
  for (const [label, value, selected] of fields) {
    const row = box(ctx, { width: "100%", height: 3, border: true, borderColor: selected ? C.accent : C.border, paddingLeft: 1, paddingRight: 1 });
    add(row, appText(ctx, `${selected ? "▸" : " "} ${label}`, { fg: selected ? C.accent : C.dim }));
    add(row, text(ctx, value || "(required)", { fg: value ? C.fg : C.dim }));
    add(panel, row);
  }
  add(panel, text(ctx, "Tab/Shift-Tab field   Enter advance/connect   Space toggle remember", { fg: C.dim }));
  add(panel, text(ctx, "Ctrl-G clear token   Esc cancel connection   Paste supported in token field", { fg: C.dim }));
  if (state.onboarding.submitting) add(panel, appText(ctx, "Checking credentials…", { fg: C.warn }));
  if (state.onboarding.error) add(panel, text(ctx, `Error: ${state.onboarding.error}`, { fg: C.error }));
  return panel;
}

function issueList(ctx: Context, state: RootState, width: number): ScrollBoxRenderable {
  const filterLabel = statusFilterLabel(state.statusFilter);
  const scroll = scrollBox(ctx, { width, height: "100%", border: true, borderColor: state.focus === "List" ? C.accent : C.border, title: ` ISSUES (${state.filteredIssues.length}) ${uiSeparator()} FILTER: ${filterLabel} `, scrollY: true, flexShrink: 0 });
  for (let index = 0; index < state.filteredIssues.length; index += 1) {
    const issue = state.filteredIssues[index];
    if (!issue) continue;
    const selected = index === state.selectedIndex;
    const viewing = state.detailIssueKey === issue.key;
    // A card layout keeps the identity intact at every supported width. In
    // particular, the key is allowed to wrap instead of being squeezed into a
    // fixed column or replaced with an ellipsis.
    const row = box(ctx, { width: "100%", minWidth: 30, height: "auto", paddingTop: 1, paddingBottom: 1, paddingLeft: 1, paddingRight: 1, overflow: "hidden" });
    if (selected && C.selected) row.backgroundColor = C.selected;
    add(row, appText(ctx, `${selected ? "▸" : " "} ${issue.key}`, { fg: selected ? C.accent : viewing ? C.warn : C.blue, width: "100%", wrapMode: "char" }));
    if (selected || viewing) add(row, appText(ctx, viewing && selected ? "[SELECTED/VIEWING]" : viewing ? "[VIEWING]" : "[SELECTED]", { fg: selected ? C.accent : C.warn, width: "100%" }));
    add(row, text(ctx, `${issue.status} ${uiSeparator()} ${issue.priority} ${uiSeparator()} ${issue.assignee}`, { fg: C.dim, width: "100%", wrapMode: "word" }));
    add(row, text(ctx, `Updated ${issue.updated}`, { fg: C.dim, width: "100%", wrapMode: "word" }));
    add(row, text(ctx, issue.summary, { fg: C.fg, width: "100%", wrapMode: "word" }));
    add(scroll, row);
  }
  if (state.filteredIssues.length === 0) {
    const empty = state.search && state.statusFilter.length > 0
      ? `No issues match “${state.search}” in ${filterLabel}`
      : state.search
        ? `No issues match “${state.search}”`
        : state.statusFilter.length > 0
          ? `No ${filterLabel} issues`
          : "No assigned or watched issues";
    add(scroll, text(ctx, empty, { fg: C.dim, paddingLeft: 1, wrapMode: "word", width: "100%" }));
  }
  scroll.scrollTop = state.scroll.list;
  return scroll;
}

function statusPicker(ctx: Context, state: RootState): BoxRenderable {
  const panel = box(ctx, { position: "absolute", top: 3, left: 6, width: "48%", height: 10, zIndex: 8, backgroundColor: C.bg, border: true, borderColor: C.accent, padding: 1, title: " STATUS FILTER " });
  add(panel, appText(ctx, "Space toggle · Enter apply · Esc cancel", { fg: C.dim }));
  for (let index = 0; index < STATUS_CATEGORIES.length; index += 1) {
    const category = STATUS_CATEGORIES[index];
    if (!category) continue;
    const selected = index === state.statusPickerIndex;
    const checked = state.statusDraft.includes(category);
    add(panel, appText(ctx, `${selected ? "▸" : " "} [${checked ? "x" : " "}] ${statusCategoryLabel(category)}`, { fg: selected ? C.accent : C.fg }));
  }
  return panel;
}

function detailView(ctx: Context, state: RootState, width: number): ScrollBoxRenderable {
  const scroll = scrollBox(ctx, { width, height: Math.max(1, state.size.height - 6), minHeight: 0, border: true, borderColor: state.focus === "Detail" ? C.accent : C.border, title: state.detail?.issue.key ? ` ${state.detail.issue.key} ` : " DETAIL ", scrollY: true, flexShrink: 0 });
  const applyScrollPosition = (): void => {
    scroll.scrollTop = state.detailScrollAnchor === "end" ? scroll.scrollHeight : state.scroll.detail;
  };
  const contentSizeHandler = scroll.content.onSizeChange;
  scroll.content.onSizeChange = () => {
    contentSizeHandler?.();
    applyScrollPosition();
  };
  const viewportSizeHandler = scroll.viewport.onSizeChange;
  scroll.viewport.onSizeChange = () => {
    viewportSizeHandler?.();
    applyScrollPosition();
  };
  const finish = (): ScrollBoxRenderable => {
    // Children are present by this point. The content size callback above
    // reapplies the position after OpenTUI measures the newly attached tree.
    applyScrollPosition();
    return scroll;
  };
  if (state.detailLoading) { add(scroll, appText(ctx, "Loading issue detail…", { fg: C.warn, paddingLeft: 1 })); return finish(); }
  if (state.detailError) { add(scroll, text(ctx, state.detailError, { fg: C.error, paddingLeft: 1 })); return finish(); }
  if (!state.detail) { add(scroll, text(ctx, "Select an issue and press Enter.", { fg: C.dim, paddingLeft: 1 })); return finish(); }
  const detailText = (content: string, color = C.fg, paddingLeft = 1): void => add(scroll, text(ctx, content, { fg: color, paddingLeft, width: "100%", wrapMode: "word" }));
  detailText(state.detail.issue.summary, C.accent);
  detailText(`${state.detail.remote ? "REMOTE" : "WORKSPACE"} ${uiSeparator()} ${state.detail.issue.key} ${uiSeparator()} Comments: ${state.detail.comments.length}`, C.blue);
  detailText(`${state.detail.issue.status} ${uiSeparator()} ${state.detail.issue.priority} ${uiSeparator()} ${state.detail.issue.assignee}`, C.dim);
  detailText(`Type: ${state.detail.issueType}`);
  detailText(`Reporter: ${state.detail.reporter}`);
  detailText(`Project: ${state.detail.project}`);
  detailText(`Parent: ${state.detail.parent ?? "None"}`);
  detailText(`Labels: ${state.detail.labels.length ? state.detail.labels.join(", ") : "None"}`);
  detailText(`Due: ${state.detail.dueDate ?? "None"}`);
  detailText(`Created: ${state.detail.created}`);
  detailText(`Updated: ${state.detail.issue.updated}`);
  add(scroll, text(ctx, "DESCRIPTION", { fg: C.blue, paddingTop: 1, paddingLeft: 1 }));
  detailText(state.detail.description || "(no description)");
  add(scroll, text(ctx, `COMMENTS (${state.detail.comments.length})`, { fg: C.blue, paddingTop: 1, paddingLeft: 1 }));
  for (const comment of state.detail.comments) { detailText(`${comment.author} ${uiSeparator()} ${comment.created}`, C.dim); detailText(comment.body, C.fg, 2); }
  add(scroll, text(ctx, `ATTACHMENTS (${state.detail.attachments.length})`, { fg: C.blue, paddingTop: 1, paddingLeft: 1 }));
  for (const attachment of state.detail.attachments) detailText(`${attachment.filename} ${uiSeparator()} ${attachment.mimeType} ${uiSeparator()} ${attachment.sizeBytes} bytes`, C.dim);
  return finish();
}

function updateTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Unknown time";
  const date = new Date(parsed);
  const pad = (part: number): string => String(part).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  if (offsetMinutes === 0) return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}Z`;
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}

function updateRowLabel(event: UpdateEvent): string {
  if (event.field === "other") {
    const label = event.label || GENERIC_UPDATE_LABEL;
    return label === GENERIC_UPDATE_LABEL ? appGlyphs(label) : label;
  }
  return `${event.label}: ${event.previousValue ?? "(none)"} ${activeAsciiOnly ? "->" : "→"} ${event.currentValue ?? "(none)"}`;
}

function updatesView(ctx: Context, state: RootState): BoxRenderable {
  const groups = visibleUpdateGroups(state);
  const unreadCount = visibleUpdateGroups({ ...state, updateFilter: "unread" }).length;
  const panel = box(ctx, {
    width: "100%",
    height: "100%",
    border: true,
    borderColor: state.focus === "List" ? C.accent : C.border,
    title: ` LOCAL UPDATES ${uiSeparator()} ${state.updateFilter.toUpperCase()} ${uiSeparator()} ${unreadCount} unread `,
    padding: 1,
  });
  add(panel, appText(ctx, "u Unread/All · m Toggle read · M Mark displayed read · Space/o Expand · Enter Detail · r Local reload", { fg: C.dim, width: "100%", wrapMode: "word" }));
  if (state.confirmMarkAllUpdates) add(panel, text(ctx, "Mark all displayed updates read?  y Confirm · n/Esc Cancel", { fg: C.warn, width: "100%", wrapMode: "word" }));
  const scroll = scrollBox(ctx, { width: "100%", height: "100%", border: false, scrollY: true, flexGrow: 1 });
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group) continue;
    const selected = index === state.selectedUpdateIndex;
    const card = box(ctx, { width: "100%", height: "auto", paddingTop: 1, paddingBottom: 1, paddingLeft: 1, paddingRight: 1, overflow: "hidden" });
    if (selected && C.selected) card.backgroundColor = C.selected;
    add(card, appText(ctx, `${selected ? "▸" : " "} ${group.unread ? "●" : "○"} ${group.expanded ? "▾" : "▸"} ${group.issueKey}`, { fg: selected ? C.accent : group.unread ? C.warn : C.blue, width: "100%", wrapMode: "char" }));
    add(card, text(ctx, group.issueSummary, { fg: C.fg, width: "100%", wrapMode: "word" }));
    add(card, appText(ctx, `Latest ${updateTimestamp(group.latestAt)} · ${group.events.length} change${group.events.length === 1 ? "" : "s"}`, { fg: C.dim, width: "100%", wrapMode: "word" }));
    for (const event of group.rows) add(card, text(ctx, `  ${activeAsciiOnly ? "*" : "•"} ${updateRowLabel(event)}`, { fg: event.field === "other" ? C.dim : C.fg, width: "100%", wrapMode: "word" }));
    if (!group.expanded && group.events.length > group.rows.length) add(card, appText(ctx, `  … ${group.events.length - group.rows.length} more (Space/o to expand)`, { fg: C.dim, width: "100%", wrapMode: "word" }));
    add(scroll, card);
  }
  if (groups.length === 0) add(scroll, text(ctx, state.updateFilter === "unread" ? "No unread updates" : "No local updates yet. Refresh Jira to compare a later snapshot.", { fg: C.dim, paddingLeft: 1, width: "100%", wrapMode: "word" }));
  scroll.scrollTop = state.scroll.updates;
  add(panel, scroll);
  return panel;
}

function teamAge(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "activity time unavailable";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "age <1m";
  if (seconds < 3600) return `age ${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `age ${Math.floor(seconds / 3600)}h`;
  return `age ${Math.floor(seconds / 86400)}d`;
}

function teamView(ctx: Context, state: RootState): BoxRenderable {
  const panel = box(ctx, { width: "100%", height: "100%", border: true, borderColor: state.focus === "List" ? C.accent : C.border, title: ` TEAM TRACKER ${uiSeparator()} ${state.teamSource ?? "local"} `, padding: 1 });
  add(panel, appText(ctx, "j/k or arrows select · Enter open remote detail · r refresh Team", { fg: C.dim, width: "100%", wrapMode: "word" }));
  if (state.teamLoading) add(panel, appText(ctx, "Loading Team issues…", { fg: C.warn }));
  if (state.teamError) add(panel, text(ctx, state.teamError, { fg: C.error, width: "100%", wrapMode: "word" }));
  if (state.teamRefreshedAt) add(panel, text(ctx, `Updated ${state.teamRefreshedAt}`, { fg: C.dim, width: "100%" }));
  const scroll = scrollBox(ctx, { width: "100%", height: "100%", border: false, scrollY: true, flexGrow: 1 });
  for (let index = 0; index < state.teamIssues.length; index += 1) {
    const issue = state.teamIssues[index];
    if (!issue) continue;
    const selected = index === state.teamSelectedIndex;
    const viewing = state.detailIssueKey === issue.key;
    const row = box(ctx, { width: "100%", height: "auto", paddingTop: 1, paddingBottom: 1, paddingLeft: 1, paddingRight: 1, overflow: "hidden" });
    if (selected && C.selected) row.backgroundColor = C.selected;
    add(row, appText(ctx, `${selected ? "▸" : " "} ${issue.key}`, { fg: selected ? C.accent : viewing ? C.warn : C.blue, width: "100%", wrapMode: "char" }));
    if (selected || viewing) add(row, appText(ctx, viewing && selected ? "[SELECTED/VIEWING]" : viewing ? "[VIEWING]" : "[SELECTED]", { fg: selected ? C.accent : C.warn, width: "100%" }));
    // Jira/user text goes through text(), retaining Unicode even in ASCII mode.
    add(row, text(ctx, issue.summary, { fg: C.fg, width: "100%", wrapMode: "word" }));
    add(row, text(ctx, `${issue.assignee} ${uiSeparator()} ${issue.status}`, { fg: C.dim, width: "100%", wrapMode: "word" }));
    add(row, text(ctx, `Updated ${issue.updated || "unknown"} ${uiSeparator()} ${teamAge(issue.updated)}`, { fg: C.dim, width: "100%", wrapMode: "word" }));
    add(scroll, row);
  }
  if (state.teamIssues.length === 0 && !state.teamLoading && !state.teamError) add(scroll, text(ctx, "No team issues yet. Configure Team members in Settings, then press r to refresh.", { fg: C.dim, width: "100%", wrapMode: "word" }));
  scroll.scrollTop = state.scroll.team;
  add(panel, scroll);
  return panel;
}

function overlay(ctx: Context, title: string, lines: string[], focus: RootState["focus"], appContent = false): BoxRenderable {
  const panel = box(ctx, { position: "absolute", top: 2, left: 4, width: "80%", height: "80%", zIndex: 10, backgroundColor: C.bg, border: true, borderColor: C.accent, padding: 1, title: ` ${title} ` });
  add(panel, text(ctx, `Focus: ${focus}   Esc close`, { fg: C.dim }));
  const scroll = scrollBox(ctx, { width: "100%", height: "100%", scrollY: true, border: false });
  for (const line of lines) add(scroll, appContent ? appText(ctx, line, { fg: C.fg }) : text(ctx, line, { fg: C.fg }));
  add(panel, scroll); return panel;
}

function secondarySection(ctx: Context, state: RootState): BoxRenderable {
  const titles = { updates: "LOCAL UPDATES", team: "TEAM TRACKER", settings: "SETTINGS" } as const;
  if (state.section === "updates") return updatesView(ctx, state);
  const panel = box(ctx, {
    width: "100%",
    height: "100%",
    border: true,
    borderColor: state.section === "settings" && state.focus === "Settings" ? C.accent : C.border,
    title: ` ${titles[state.section as keyof typeof titles]} `,
    padding: 2,
  });
  if (state.section === "settings") {
    add(panel, appText(ctx, `Settings${state.appearanceDirty ? " *" : ""}`, { fg: C.blue }));
    const settingsRows = [
      ["Jira scope", state.scopeEditing ? (state.scopeDraft || "(empty)") : (state.jqlScope || "Default")],
      ["Team members", state.teamMembersEditing ? (state.teamMembersDraft.split("\n").filter(Boolean).length.toString()) : `${state.teamMemberCount}`],
      ["Theme", state.draftAppearance.theme],
      ["No color", state.draftAppearance.noColor ? "On" : "Off"],
      ["ASCII-only", state.draftAppearance.asciiOnly ? "On" : "Off"],
    ] as const;
    for (let index = 0; index < settingsRows.length; index += 1) {
      const row = settingsRows[index];
      if (!row) continue;
      const selected = index === state.settingsRow;
      const marker = selected ? (activeAsciiOnly ? ">" : "▸") : " ";
      const scopeProgress = state.scopeSaving && index === 0 ? (activeAsciiOnly ? " ..." : " …") : "";
      const dirty = index === 1 && state.teamMembersEditing ? " *" : index > 1 && state.appearanceDirty ? " *" : "";
      add(panel, index === 0
        ? text(ctx, `${marker} ${row[0]}: ${row[1]}${scopeProgress}`, { fg: selected ? C.accent : C.fg, paddingTop: 1, width: "100%", wrapMode: "word" })
        : appText(ctx, `${marker} ${row[0]}: ${row[1]}${dirty}`, { fg: selected ? C.accent : C.fg }));
    }
    if (state.scopeEditing) {
      add(panel, text(ctx, "JQL editor", { fg: C.blue, paddingTop: 1 }));
      add(panel, text(ctx, state.scopeDraft || "_", { fg: C.fg, width: "100%", wrapMode: "word" }));
      add(panel, text(ctx, `Attempted: ${state.scopeDraft || "(blank)"}`, { fg: C.dim, width: "100%", wrapMode: "word" }));
      add(panel, text(ctx, `Active: ${state.jqlScope || "Default"}`, { fg: C.dim, width: "100%", wrapMode: "word" }));
      add(panel, appText(ctx, `${new TextEncoder().encode(state.scopeDraft).byteLength}/${MAX_JQL_SCOPE_BYTES} UTF-8 bytes${state.scopeSaving ? " · Saving…" : ""}`, { fg: state.scopeSaving ? C.warn : C.dim }));
      if (state.scopeError) add(panel, text(ctx, `Error: ${state.scopeError}`, { fg: C.error, width: "100%", wrapMode: "word" }));
      add(panel, appText(ctx, "Ctrl-s save · Esc close/cancel save · x restore active · Paste supported", { fg: C.dim, width: "100%", wrapMode: "word" }));
    } else if (state.teamMembersEditing) {
      add(panel, text(ctx, "Team members editor", { fg: C.blue, paddingTop: 1 }));
      add(panel, text(ctx, state.teamMembersDraft || "_", { fg: C.fg, width: "100%", wrapMode: "word" }));
      add(panel, text(ctx, `Attempted: ${state.teamMembersDraft || "(empty)"}`, { fg: C.dim, width: "100%", wrapMode: "word" }));
      add(panel, text(ctx, `Active: ${state.teamMembers.length ? state.teamMembers.join("\n") : "(empty)"}`, { fg: C.dim, width: "100%", wrapMode: "word" }));
      add(panel, appText(ctx, `${new TextEncoder().encode(state.teamMembersDraft).byteLength}/${MAX_TEAM_MEMBERS_BYTES} UTF-8 bytes${state.teamMembersSaving ? " · Saving…" : ""}`, { fg: state.teamMembersSaving ? C.warn : C.dim }));
      if (state.teamMembersError) add(panel, text(ctx, `Error: ${state.teamMembersError}`, { fg: C.error, width: "100%", wrapMode: "word" }));
      add(panel, appText(ctx, "Enter newline · Ctrl-s save · Esc close/cancel save · x restore active · Paste supported", { fg: C.dim, width: "100%", wrapMode: "word" }));
    } else {
      add(panel, appText(ctx, "j/k or arrows select · Space/Enter edit or change · Ctrl-s save · Ctrl-r reload · x restore", { fg: C.dim, paddingTop: 1, width: "100%", wrapMode: "word" }));
    }
      add(panel, text(ctx, `Team members configured: ${state.teamMemberCount}`, { fg: C.fg, width: "100%" }));
    add(panel, appText(ctx, "Team membership is a summary; Jira scope is read-only in Jira and controls this workspace query.", { fg: C.dim, width: "100%", wrapMode: "word" }));
    add(panel, text(ctx, "Saved login", { fg: C.blue }));
    add(panel, text(ctx, "Stored with Bun.secrets (macOS Keychain / Linux libsecret).", { fg: C.fg }));
    add(panel, text(ctx, "No plaintext fallback. The current session stays connected after removal.", { fg: C.dim }));
    add(panel, appText(ctx, state.confirmForgetLogin ? "Forget saved login?  y Confirm · n Cancel" : "f Forget saved login", { fg: state.confirmForgetLogin ? C.warn : C.accent, paddingTop: 1 }));
  } else {
    add(panel, text(ctx, "This screen is reserved for a later read-only milestone.", { fg: C.dim }));
    add(panel, text(ctx, "Issues, exact lookup, detail, comments, and attachment metadata are available now.", { fg: C.fg, paddingTop: 1 }));
  }
  return panel;
}

export function renderApp(renderer: CliRenderer, state: RootState): void {
  // OpenTUI registers one selection listener per selectable renderable. Keep
  // the emitter warning-free for legitimate frames; recursive root cleanup
  // prevents those listeners from accumulating across redraws.
  renderer.setMaxListeners(0);
  // Renderable construction is synchronous. A frame-local palette avoids
  // leaking renderer state into the reducer or any asynchronous operation.
  activePalette = paletteFor(state.theme, state.detectedTheme, state.draftAppearance.noColor);
  activeAsciiOnly = state.draftAppearance.asciiOnly;
  clearRoot(renderer);
  const root = box(renderer, { width: "100%", height: "100%", backgroundColor: C.bg });
  add(root, titleBar(renderer, state));
  if (state.phase === "onboarding") add(root, onboarding(renderer, state));
  else {
    const main = box(renderer, { width: "100%", flexGrow: 1, height: "auto", flexDirection: "row", padding: 1 });
    if (state.layout.mode === "warning") {
      add(main, text(renderer, state.layout.warning ?? "Resize terminal", { fg: C.warn, width: "100%" }));
    } else {
      if (state.layout.nav) {
        const nav = box(renderer, { width: state.layout.nav.width, height: "100%", border: true, borderColor: state.focus === "Nav" ? C.accent : C.border, padding: 1, flexShrink: 0 });
        for (const [key, label] of [["1", "Issues"], ["2", "Updates"], ["3", "Team"], ["4", "Settings"]] as const) add(nav, appText(renderer, `${state.focus === "Nav" && state.section.toLowerCase() === label.toLowerCase() ? "▸" : " "} ${key} ${label}`, { fg: C.fg }));
        add(main, nav);
      }
      const listWidth = state.layout.list.width;
      if (state.section === "team") {
        if (state.layout.mode === "one-pane" && state.focus === "Detail") add(main, detailView(renderer, state, listWidth));
        else {
          add(main, teamView(renderer, state));
          if (state.layout.detail && state.layout.mode !== "one-pane") add(main, detailView(renderer, state, state.layout.detail.width));
        }
      } else if (state.section !== "issues") {
        add(main, secondarySection(renderer, state));
      } else if (state.layout.mode === "one-pane" && state.focus === "Detail") {
        add(main, detailView(renderer, state, listWidth));
      } else {
        add(main, issueList(renderer, state, listWidth));
        if (state.layout.detail && state.layout.mode !== "one-pane") add(main, detailView(renderer, state, state.layout.detail.width));
      }
      if (state.focus === "Picker" && state.pickerMode !== "status") add(main, text(renderer, `Exact issue key: ${state.lookupEditor || "_"}`, { fg: C.accent, position: "absolute", top: 0, left: 1, zIndex: 5 }));
      if (state.layout.event) {
        const log = scrollBox(renderer, { width: state.layout.event.width, height: "100%", border: true, borderColor: C.border, title: " EVENTS ", scrollY: true, flexShrink: 0 });
        for (const item of state.events) add(log, text(renderer, `${item.kind}: ${item.message}`, { fg: C.dim }));
        log.scrollTop = state.scroll.eventLog; add(main, log);
      }
    }
    add(root, main);
  }
  add(root, footer(renderer, state));
  if (state.overlays.help) add(root, overlay(renderer, "HELP", ["Navigation", "1 Issues · 2 Updates · 3 Team · 4 Settings", "↑/↓ or j/k Move selection", "Tab/Shift-Tab Move focus", "Enter Open issue / submit onboarding", "Ctrl-G Clear onboarding token · Esc cancel connection", "/ Search locally", "s Status filter · Space toggle · Enter apply · Esc cancel", "l Exact issue-key lookup", "r Refresh Jira (Issues) or Team (Team)", "Team: Enter opens remote detail without changing primary membership", "Settings: Jira scope row Space/Enter edit · Ctrl-s save · Esc close/cancel · x restore active", "Settings: Team members row always opens multiline editor; Enter newline · Ctrl-s save", "Settings: Theme/No color/ASCII-only rows cycle with Space/Enter", "Ctrl-s saves the selected settings row", "f Forget saved login (Settings)", "e Event log", "q Quit", "All Jira operations are read-only."], state.focus, true));
  if (state.overlays.eventLog) add(root, overlay(renderer, "EVENT LOG", state.events.map((item) => `${item.at} ${item.kind}: ${item.message}`), state.focus));
  if (state.focus === "Picker" && state.pickerMode === "status") add(root, statusPicker(renderer, state));
  renderer.root.add(root);
}
