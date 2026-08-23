import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { parseIssueId, parseIssueKey, type IssueDetail, type IssueSummary } from "../src/domain";
import { renderApp } from "../src/render/app";
import { initialState, reduce } from "../src/state";

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

async function frameAt(width: number, height: number, withDetail = false, detailValue = detail): Promise<string> {
  const setup = await createTestRenderer({ width, height });
  try {
    let state = initialState({ width, height });
    state = reduce(state, {
      type: "workspace_snapshot",
      siteLabel: "example.atlassian.net",
      identity: "Ada",
      issues: [issue],
      source: "cache",
      refreshedAt: "now",
      generation: 0,
    });
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
});
