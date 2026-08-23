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
  parent: null,
  labels: ["tui"],
  dueDate: null,
  created: "2026-08-01T00:00:00.000Z",
  description: "A safely projected Jira description.",
  comments: [],
  attachments: [],
  remote: false,
};

async function frameAt(width: number, height: number, withDetail = false): Promise<string> {
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
      state = reduce(state, { type: "detail_result", issueKey: longKey, issue: detail, generation: 1 });
    }
    renderApp(setup.renderer, state);
    await setup.renderOnce();
    return setup.captureCharFrame();
  } finally {
    setup.renderer.destroy();
  }
}

describe("OpenTUI frames", () => {
  test("preserves the complete issue key at one-pane boundaries", async () => {
    for (const width of [79, 80, 119]) {
      expect(await frameAt(width, 24)).toContain(longKey);
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

  test("renders the actual-size warning below the supported geometry", async () => {
    const frame = await frameAt(60, 19);
    expect(frame).toContain("60x19");
    expect(frame).toContain("minimum 60x20");
  });
});
