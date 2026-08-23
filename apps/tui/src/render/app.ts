import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";
import { maskedSecret } from "../secure-input";
import type { RootState } from "../state";

const C = { fg: "#e6e1d6", dim: "#9b978d", accent: "#7dd3a3", blue: "#8ab4f8", warn: "#f2c97d", error: "#f28b82", bg: "#171817", panel: "#20221f", selected: "#2d3d35", border: "#59635b" };

type Context = CliRenderer;
type Style = ConstructorParameters<typeof BoxRenderable>[1];

function box(ctx: Context, options: Style = {}): BoxRenderable { return new BoxRenderable(ctx, { flexDirection: "column", flexShrink: 0, ...options }); }
function text(ctx: Context, content: string, options: ConstructorParameters<typeof TextRenderable>[1] = {}): TextRenderable {
  return new TextRenderable(ctx, { content, flexShrink: 0, ...options });
}
function add(parent: Renderable, child: Renderable): void { parent.add(child); }

function clearRoot(renderer: Context): void {
  for (const child of renderer.root.getChildren()) child.destroy();
}

function titleBar(ctx: Context, state: RootState): BoxRenderable {
  const header = box(ctx, { width: "100%", height: 2, backgroundColor: C.panel, paddingLeft: 1, paddingRight: 1, flexDirection: "row", alignItems: "center" });
  add(header, text(ctx, "JIRA DESK", { fg: C.accent, width: 12 }));
  add(header, text(ctx, state.siteLabel ? `${state.siteLabel} · ${state.identity ?? ""}` : "Read-only Jira workspace", { fg: C.dim, flexGrow: 1, width: "auto" }));
  add(header, text(ctx, state.theme === "System" ? `System/${state.detectedTheme ?? "?"}` : state.theme, { fg: C.dim, width: 18 }));
  return header;
}

function footer(ctx: Context, state: RootState): BoxRenderable {
  const footer = box(ctx, { width: "100%", height: 2, backgroundColor: C.panel, paddingLeft: 1, flexDirection: "row", alignItems: "center" });
  add(footer, text(ctx, state.lastMessage ?? "? Help   e Events   / Search   l Lookup   r Refresh   Enter Detail   q Quit", { fg: state.lastMessage ? C.accent : C.dim, flexGrow: 1, width: "auto" }));
  add(footer, text(ctx, `${state.focus} · ${state.layout.mode}`, { fg: C.dim, width: 24 }));
  return footer;
}

function onboarding(ctx: Context, state: RootState): BoxRenderable {
  const panel = box(ctx, { width: "100%", height: "100%", padding: 2, border: true, borderColor: C.border, title: " CONNECT TO JIRA (read-only) " });
  add(panel, text(ctx, "Credentials stay in the private backend and are never logged or rendered.", { fg: C.dim }));
  const fields: Array<[string, string, boolean]> = [["Jira HTTPS URL", state.onboarding.baseUrl, state.onboarding.field === "baseUrl"], ["Atlassian email", state.onboarding.email, state.onboarding.field === "email"], ["Scoped API token", maskedSecret(state.onboarding.token), state.onboarding.field === "token"], ["Remember securely", state.onboarding.remember ? "[x]" : "[ ]", state.onboarding.field === "remember"]];
  for (const [label, value, selected] of fields) {
    const row = box(ctx, { width: "100%", height: 3, border: true, borderColor: selected ? C.accent : C.border, paddingLeft: 1, paddingRight: 1 });
    add(row, text(ctx, `${selected ? "▸" : " "} ${label}`, { fg: selected ? C.accent : C.dim }));
    add(row, text(ctx, value || "(required)", { fg: value ? C.fg : C.dim }));
    add(panel, row);
  }
  add(panel, text(ctx, "Tab/Shift-Tab field   Enter advance/connect   Space toggle remember   Paste supported in token field", { fg: C.dim }));
  if (state.onboarding.submitting) add(panel, text(ctx, "Checking credentials…", { fg: C.warn }));
  if (state.onboarding.error) add(panel, text(ctx, `Error: ${state.onboarding.error}`, { fg: C.error }));
  return panel;
}

function issueList(ctx: Context, state: RootState, width: number): ScrollBoxRenderable {
  const scroll = new ScrollBoxRenderable(ctx, { width, height: "100%", border: true, borderColor: state.focus === "List" ? C.accent : C.border, title: ` ISSUES (${state.filteredIssues.length}) `, scrollY: true, flexShrink: 0 });
  scroll.scrollTop = state.scroll.list;
  for (let index = 0; index < state.filteredIssues.length; index += 1) {
    const issue = state.filteredIssues[index];
    if (!issue) continue;
    const selected = index === state.selectedIndex;
    const row = box(ctx, { width: "100%", minWidth: 30, height: 2, flexDirection: "row", paddingLeft: 1, paddingRight: 1 });
    if (selected) row.backgroundColor = C.selected;
    // The key has no ellipsis and flexShrink 0; only the summary yields space.
    add(row, text(ctx, `${selected ? "▸" : " "} ${issue.key}`, { fg: selected ? C.accent : C.blue, width: Math.min(18, Math.max(10, issue.key.length + 3)), minWidth: issue.key.length + 3, flexShrink: 0 }));
    add(row, text(ctx, issue.summary, { fg: C.fg, flexGrow: 1, flexShrink: 1, width: "auto" }));
    add(scroll, row);
  }
  if (state.filteredIssues.length === 0) add(scroll, text(ctx, state.search ? `No issues match “${state.search}”` : "No assigned or watched issues", { fg: C.dim, paddingLeft: 1 }));
  return scroll;
}

function detailView(ctx: Context, state: RootState, width: number): ScrollBoxRenderable {
  const scroll = new ScrollBoxRenderable(ctx, { width, height: "100%", border: true, borderColor: state.focus === "Detail" ? C.accent : C.border, title: state.detail?.issue.key ? ` ${state.detail.issue.key} ` : " DETAIL ", scrollY: true, flexShrink: 0 });
  scroll.scrollTop = state.scroll.detail;
  if (state.detailLoading) { add(scroll, text(ctx, "Loading issue detail…", { fg: C.warn, paddingLeft: 1 })); return scroll; }
  if (state.detailError) { add(scroll, text(ctx, state.detailError, { fg: C.error, paddingLeft: 1 })); return scroll; }
  if (!state.detail) { add(scroll, text(ctx, "Select an issue and press Enter.", { fg: C.dim, paddingLeft: 1 })); return scroll; }
  add(scroll, text(ctx, state.detail.issue.summary, { fg: C.accent, paddingLeft: 1 }));
  add(scroll, text(ctx, `${state.detail.issue.status} · ${state.detail.issue.priority} · ${state.detail.issue.assignee}`, { fg: C.dim, paddingLeft: 1 }));
  add(scroll, text(ctx, `${state.detail.issue.key} · ${state.detail.issue.updated}`, { fg: C.dim, paddingLeft: 1 }));
  add(scroll, text(ctx, "DESCRIPTION", { fg: C.blue, paddingTop: 1, paddingLeft: 1 }));
  add(scroll, text(ctx, state.detail.description || "(no description)", { fg: C.fg, paddingLeft: 1, width: "100%" }));
  add(scroll, text(ctx, `COMMENTS (${state.detail.comments.length})`, { fg: C.blue, paddingTop: 1, paddingLeft: 1 }));
  for (const comment of state.detail.comments) { add(scroll, text(ctx, `${comment.author} · ${comment.created}`, { fg: C.dim, paddingLeft: 1 })); add(scroll, text(ctx, comment.body, { fg: C.fg, paddingLeft: 2 })); }
  add(scroll, text(ctx, `ATTACHMENTS (${state.detail.attachments.length})`, { fg: C.blue, paddingTop: 1, paddingLeft: 1 }));
  for (const attachment of state.detail.attachments) add(scroll, text(ctx, `${attachment.filename} · ${attachment.mimeType} · ${attachment.sizeBytes} bytes`, { fg: C.dim, paddingLeft: 1 }));
  return scroll;
}

function overlay(ctx: Context, title: string, lines: string[], focus: RootState["focus"]): BoxRenderable {
  const panel = box(ctx, { position: "absolute", top: 2, left: 4, width: "80%", height: "80%", zIndex: 10, backgroundColor: C.bg, border: true, borderColor: C.accent, padding: 1, title: ` ${title} ` });
  add(panel, text(ctx, `Focus: ${focus}   Esc close`, { fg: C.dim }));
  const scroll = new ScrollBoxRenderable(ctx, { width: "100%", height: "100%", scrollY: true, border: false });
  for (const line of lines) add(scroll, text(ctx, line, { fg: C.fg }));
  add(panel, scroll); return panel;
}

function secondarySection(ctx: Context, state: RootState): BoxRenderable {
  const titles = { updates: "LOCAL UPDATES", team: "TEAM TRACKER", settings: "SETTINGS" } as const;
  const panel = box(ctx, {
    width: "100%",
    height: "100%",
    border: true,
    borderColor: state.section === "settings" && state.focus === "Settings" ? C.accent : C.border,
    title: ` ${titles[state.section as keyof typeof titles]} `,
    padding: 2,
  });
  if (state.section === "settings") {
    add(panel, text(ctx, "Saved login", { fg: C.blue }));
    add(panel, text(ctx, "Stored with Bun.secrets (macOS Keychain / Linux libsecret).", { fg: C.fg }));
    add(panel, text(ctx, "No plaintext fallback. The current session stays connected after removal.", { fg: C.dim }));
    add(panel, text(ctx, state.confirmForgetLogin ? "Forget saved login?  y Confirm · n Cancel" : "f Forget saved login", { fg: state.confirmForgetLogin ? C.warn : C.accent, paddingTop: 1 }));
  } else {
    add(panel, text(ctx, "This screen is reserved for a later read-only milestone.", { fg: C.dim }));
    add(panel, text(ctx, "Issues, exact lookup, detail, comments, and attachment metadata are available now.", { fg: C.fg, paddingTop: 1 }));
  }
  return panel;
}

export function renderApp(renderer: CliRenderer, state: RootState): void {
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
        for (const [key, label] of [["1", "Issues"], ["2", "Updates"], ["3", "Team"], ["4", "Settings"]] as const) add(nav, text(renderer, `${state.focus === "Nav" && state.section.toLowerCase() === label.toLowerCase() ? "▸" : " "} ${key} ${label}`, { fg: C.fg }));
        add(main, nav);
      }
      const listWidth = state.layout.list.width;
      if (state.section !== "issues") {
        add(main, secondarySection(renderer, state));
      } else if (state.layout.mode === "one-pane" && state.focus === "Detail") {
        add(main, detailView(renderer, state, listWidth));
      } else {
        add(main, issueList(renderer, state, listWidth));
        if (state.layout.detail && state.layout.mode !== "one-pane") add(main, detailView(renderer, state, state.layout.detail.width));
      }
      if (state.focus === "Picker") add(main, text(renderer, `Exact issue key: ${state.lookupEditor || "_"}`, { fg: C.accent, position: "absolute", top: 0, left: 1, zIndex: 5 }));
      if (state.layout.event) {
        const log = new ScrollBoxRenderable(renderer, { width: state.layout.event.width, height: "100%", border: true, borderColor: C.border, title: " EVENTS ", scrollY: true, flexShrink: 0 });
        log.scrollTop = state.scroll.eventLog; for (const item of state.events) add(log, text(renderer, `${item.kind}: ${item.message}`, { fg: C.dim })); add(main, log);
      }
    }
    add(root, main);
  }
  add(root, footer(renderer, state));
  if (state.overlays.help) add(root, overlay(renderer, "HELP", ["Navigation", "1 Issues · 2 Updates · 3 Team · 4 Settings", "↑/↓ or j/k Move selection", "Tab/Shift-Tab Move focus", "Enter Open issue / submit onboarding", "/ Search locally", "l Exact issue-key lookup", "r Refresh from Jira", "f Forget saved login (Settings)", "e Event log", "q Quit", "All Jira operations are read-only."], state.focus));
  if (state.overlays.eventLog) add(root, overlay(renderer, "EVENT LOG", state.events.map((item) => `${item.at} ${item.kind}: ${item.message}`), state.focus));
  renderer.root.add(root);
}
