import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { parseIssueId, parseIssueKey, type IssueDetail, type IssueSummary } from "../src/domain";
import { paletteFor, renderApp } from "../src/render/app";
import { initialState, reduce, visibleUpdateGroups } from "../src/state";
import { applyUpdateSnapshot, emptyUpdateLedger } from "../src/updates/ledger";

const longKey = parseIssueKey("EXTRAORDINARILY_LONG_PROJECT_KEY-123456789");
const issue: IssueSummary = {
  id: parseIssueId("10001"),
  key: longKey,
  summary: "A summary that yields space before the complete identity",
  status: "In Progress",
  statusCategory: "in_progress",
  priority: "High",
  assignee: "Ada Lovelace",
  updated: "2026-08-23T00:00:00.000Z",
};
const detail: IssueDetail = {
  issue,
  issueType: "Task",
  reporter: "Grace Hopper",
  project: "Terminal client",
  parent: "PLATFORM-7",
  labels: ["tui", "read-only"],
  dueDate: "2026-09-01",
  created: "2026-08-01T00:00:00.000Z",
  description: "A safely projected Jira description.",
  comments: [{ id: "c-1", author: "Linus Torvalds", created: "2026-08-02T00:00:00.000Z", updated: "2026-08-02T00:00:00.000Z", body: "A read-only review comment." }],
  attachments: [{ id: "a-1", filename: "design.txt", mimeType: "text/plain", sizeBytes: 42 }],
  remote: false,
};

const workspaceSnapshot = (issues: readonly IssueSummary[], options: { source?: "cache" | "jira"; refreshedAt?: string; updates?: ReturnType<typeof emptyUpdateLedger>; updatesBaselineEstablished?: boolean } = {}) => ({
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

async function frameAt(width: number, height: number, withDetail = false, detailValue = detail): Promise<string> {
  const setup = await createTestRenderer({ width, height });
  try {
    let state = initialState({ width, height });
    state = reduce(state, workspaceSnapshot([issue]));
    if (withDetail) {
      state = reduce(state, { type: "detail_start", issueKey: longKey });
      state = reduce(state, { type: "detail_result", issueKey: longKey, issue: detailValue, generation: 1 });
    }
    renderApp(setup.renderer, state);
    await setup.renderOnce();
    return setup.captureCharFrame();
  } finally {
    setup.renderer.destroy();
  }
}

describe("OpenTUI frames", () => {
  test("resolves distinct light/dark palettes and ASCII app glyphs", async () => {
    expect(paletteFor("Light", null).bg).not.toBe(paletteFor("Dark", null).bg);
    const setup = await createTestRenderer({ width: 120, height: 40 });
    try {
      let state = reduce(initialState({ width: 120, height: 40 }), workspaceSnapshot([issue]));
      state = reduce(state, { type: "appearance_move", delta: 2 });
      state = reduce(state, { type: "appearance_cycle" });
      renderApp(setup.renderer, state);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("+");
      expect(frame).not.toMatch(/[▸●○▾…•→·]/u);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("keeps no-color palette values absent while rendering normally", async () => {
    const noColor = paletteFor("Dark", null, true);
    expect(noColor.fg).toBeUndefined();
    expect(noColor.bg).toBeUndefined();
    expect(noColor.border).toBeUndefined();
    const setup = await createTestRenderer({ width: 120, height: 40 });
    try {
      let state = reduce(initialState({ width: 120, height: 40 }), workspaceSnapshot([issue]));
      state = reduce(state, { type: "appearance_move", delta: 1 });
      state = reduce(state, { type: "appearance_cycle" });
      renderApp(setup.renderer, state);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("JIRA DESK");
      expect(setup.renderer.listenerCount("selection")).toBeGreaterThan(0);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("preserves the complete issue key and row metadata at every supported width", async () => {
    for (const width of [60, 79, 80, 119, 120, 160]) {
      const frame = await frameAt(width, 24);
      // Narrow cards wrap the key across terminal rows; no characters may be
      // dropped or replaced with an ellipsis.
      const completeKey = frame.includes(longKey)
        || (frame.includes("EXTRAORDINARILY_LONG_PROJECT_KEY-1234") && frame.includes("56789"))
        || (frame.includes("EXTRAORDINARILY_LONG_PROJECT_KEY-1") && frame.includes("23456789"));
      expect(completeKey).toBe(true);
      expect(frame).toContain("In Progress");
      expect(frame).toContain("High");
      expect(frame).toContain("Ada Lovelace");
      expect(frame).toContain("Updated 2026-08-23T00:00:00.000Z");
    }
  });

  test("keeps list and detail visible at two-pane boundaries", async () => {
    for (const [width, height] of [[120, 40], [160, 48]] as const) {
      const frame = await frameAt(width, height, true);
      expect(frame).toContain(longKey);
      expect(frame).toContain("DESCRIPTION");
      expect(frame).toContain("A safely projected Jira description.");
    }
  });

  test("renders workspace detail provenance and every available detail field", async () => {
    const frame = await frameAt(160, 80, true);
    for (const value of [
      "WORKSPACE", "Type: Task", "Reporter: Grace Hopper", "Project: Terminal client",
      "Parent: PLATFORM-7", "Labels: tui, read-only", "Due: 2026-09-01",
      "Created: 2026-08-01T00:00:00.000Z", "Updated: 2026-08-23T00:00:00.000Z",
      "A read-only review comment.", "design.txt · text/plain · 42 bytes",
    ]) expect(frame).toContain(value);
  });

  test("renders remote detail provenance distinctly", async () => {
    const frame = await frameAt(120, 60, true, { ...detail, remote: true });
    expect(frame).toContain("REMOTE");
    expect(frame).not.toContain("WORKSPACE");
  });

  test("renders the actual-size warning below the supported geometry", async () => {
    const frame = await frameAt(60, 19);
    expect(frame).toContain("60x19");
    expect(frame).toContain("minimum 60x20");
  });

  test("renders the applied status filter and draft picker", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 });
    try {
      let state = initialState({ width: 120, height: 40 });
      state = reduce(state, workspaceSnapshot([issue]));
      state = reduce(state, { type: "open_status_picker" });
      renderApp(setup.renderer, state);
      await setup.renderOnce();
      const pickerFrame = setup.captureCharFrame();
      expect(pickerFrame).toContain("STATUS FILTER");
      expect(pickerFrame).toContain("To Do");
      expect(pickerFrame).toContain("In Progress");

      state = reduce(state, { type: "move_status_picker", delta: 1 });
      state = reduce(state, { type: "toggle_status_draft" });
      state = reduce(state, { type: "apply_status_filter" });
      renderApp(setup.renderer, state);
      await setup.renderOnce();
      const appliedFrame = setup.captureCharFrame();
      expect(appliedFrame).toContain("FILTER: In Progress");
      expect(appliedFrame).toContain("EXTRAORDINARILY_LONG_PROJECT_KEY-1234");
      expect(appliedFrame).toContain("56789");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("does not accumulate selection listeners across repeated redraws", async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 });
    try {
      const state = reduce(initialState({ width: 120, height: 40 }), workspaceSnapshot([issue]));
      renderApp(setup.renderer, state);
      await setup.renderOnce();
      const firstListenerCount = setup.renderer.listenerCount("selection");
      expect(firstListenerCount).toBeGreaterThan(0);

      for (let redraw = 0; redraw < 25; redraw += 1) {
        renderApp(setup.renderer, state);
        await setup.renderOnce();
        expect(setup.renderer.listenerCount("selection")).toBe(firstListenerCount);
      }
    } finally {
      setup.renderer.destroy();
    }
  });

  test("renders grouped local Updates with complete keys, local offset timestamps, generic rows, and collapsed limits", async () => {
    const setup = await createTestRenderer({ width: 140, height: 48 });
    try {
      const base = { ...issue, summary: "Original summary", status: "Open", statusCategory: "to_do" as const, priority: "Low", assignee: "Ada", updated: "2026-08-23T00:00:00Z" };
      const changed = { ...base, summary: "Changed summary", status: "Done", statusCategory: "done" as const, priority: "High", assignee: "Bea", updated: "2026-08-24T01:02:03+05:30" };
      let state = reduce(initialState({ width: 140, height: 48 }), workspaceSnapshot([base], { refreshedAt: "initial", updatesBaselineEstablished: true }));
      state = reduce(state, workspaceSnapshot([changed], { source: "jira", refreshedAt: "later", updates: applyUpdateSnapshot(emptyUpdateLedger(), [base], [changed]), updatesBaselineEstablished: true }));
      state = reduce(state, { type: "set_section", section: "updates" });
      expect(visibleUpdateGroups(state)[0]?.rows).toHaveLength(3);
      renderApp(setup.renderer, state);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("LOCAL UPDATES");
      expect(frame).toContain(longKey);
      expect(frame).toMatch(/Latest \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})/);
      expect(frame).toContain("Summary changed");
      expect(frame).toContain("… 1 more");

      const newIssue = { ...issue, id: parseIssueId("10002"), key: parseIssueKey("OTHER-987654321"), summary: "Newly visible issue", updated: "2026-08-24T02:00:00Z" };
      state = reduce(state, workspaceSnapshot([changed, newIssue], { source: "jira", refreshedAt: "later-2", updates: applyUpdateSnapshot(applyUpdateSnapshot(emptyUpdateLedger(), [base], [changed]), [changed], [changed, newIssue]), updatesBaselineEstablished: true }));
      state = reduce(state, { type: "set_section", section: "updates" });
      renderApp(setup.renderer, state);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Other Jira activity · exact field not available from sync");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("ASCII converts generic activity markers but preserves Jira text punctuation", async () => {
    const setup = await createTestRenderer({ width: 140, height: 48 });
    try {
      const base = { ...issue, summary: "User “quote” → middle · bullet •", status: "Open", statusCategory: "to_do" as const, updated: "2026-08-23T00:00:00Z" };
      const changed = { ...base, summary: "Current “quote” → middle · bullet •", updated: "2026-08-24T01:02:03Z" };
      let state = reduce(initialState({ width: 140, height: 48 }), workspaceSnapshot([base], { updatesBaselineEstablished: true }));
      state = reduce(state, workspaceSnapshot([changed], { source: "jira", refreshedAt: "later", updates: applyUpdateSnapshot(emptyUpdateLedger(), [base], [changed]), updatesBaselineEstablished: true }));
      const newIssue = { ...changed, id: parseIssueId("10002"), key: parseIssueKey("OTHER-987654321"), summary: "New “user” issue → intact · text •", updated: "2026-08-24T02:00:00Z" };
      state = reduce(state, workspaceSnapshot([changed, newIssue], { source: "jira", refreshedAt: "later-2", updates: applyUpdateSnapshot(state.updates, [changed], [changed, newIssue]), updatesBaselineEstablished: true }));
      state = reduce(state, { type: "set_section", section: "updates" });
      state = reduce(state, { type: "appearance_move", delta: 2 });
      state = reduce(state, { type: "appearance_cycle" });
      renderApp(setup.renderer, state);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Current “quote”");
      expect(frame).toContain("→ middle · bullet •");
      expect(frame).toContain("Other Jira activity . exact field not available from sync");
      expect(frame).not.toContain("Other Jira activity · exact field not available from sync");
      expect(frame).not.toMatch(/[┌┐└┘─│▸●○▾…]/u);
    } finally {
      setup.renderer.destroy();
    }
  });
});
