import { describe, expect, test } from "bun:test";
import type { IssueId, IssueSummary } from "../src/domain";
import {
  DEFAULT_UPDATE_ROW_LIMIT,
  GENERIC_UPDATE_LABEL,
  MAX_UPDATE_EVENTS,
  applyUpdateSnapshot,
  deriveUpdateEvents,
  emptyUpdateLedger,
  ingestUpdateEvents,
  markAllDisplayedRead,
  markGroupsRead,
  setGroupExpanded,
  toggleGroupRead,
  updateGroups,
} from "../src/updates";

const id = (value: string) => value as IssueId;
const issue = (number: number, changes: Partial<IssueSummary> = {}): IssueSummary => ({
  id: id(String(number)), key: `DEV-${number}` as IssueSummary["key"], summary: `Issue ${number}`,
  status: "Open", statusCategory: "to_do", priority: "Medium", assignee: "Ada",
  updated: "2026-08-23T10:00:00.000Z", ...changes,
});

describe("local updates ledger", () => {
  test("first baseline is explicitly quiet", () => {
    const current = [issue(1)];
    expect(deriveUpdateEvents(null, current)).toEqual([]);
    expect(deriveUpdateEvents([], current, { baseline: true })).toEqual([]);
    expect(applyUpdateSnapshot(emptyUpdateLedger(), null, current).events).toEqual([]);
  });

  test("derives bounded known field rows and a generic updated fallback", () => {
    const previous = [issue(1), issue(2)];
    const current = [
      issue(1, { summary: "Renamed", status: "In Progress", priority: "High", assignee: "Grace", updated: "2026-08-23T11:00:00.000Z" }),
      issue(2, { updated: "2026-08-23T11:30:00.000Z" }),
    ];
    const events = deriveUpdateEvents(previous, current);
    expect(events.map((event) => event.field)).toEqual(["other", "summary", "status", "priority", "assignee"]);
    expect(events[0]?.label).toBe(GENERIC_UPDATE_LABEL);
    expect(events.find((event) => event.field === "summary")?.previousValue).toBe("Issue 1");
    expect(events.find((event) => event.field === "assignee")?.currentValue).toBe("Grace");
    expect(events.every((event) => event.id.length <= 72)).toBe(true);
    expect(events.every((event) => !event.id.includes("Renamed"))).toBe(true);
  });

  test("groups by stable ID in deterministic newest-first order", () => {
    const previous = [issue(1), issue(2)];
    const current = [
      issue(2, { summary: "Two changed", updated: "2026-08-23T12:00:00.000Z" }),
      issue(1, { summary: "One changed", updated: "2026-08-23T11:00:00.000Z" }),
    ];
    const ledger = applyUpdateSnapshot(emptyUpdateLedger(), previous, current);
    const groups = updateGroups(ledger);
    expect(groups.map((group) => String(group.issueId))).toEqual(["2", "1"]);
    expect(groups[0]?.events).toHaveLength(1);
    expect(groups[0]?.latestAt).toBe("2026-08-23T12:00:00.000Z");
  });

  test("caps retained events and removes issues outside the current view", () => {
    const previous = Array.from({ length: MAX_UPDATE_EVENTS + 20 }, (_, number) => issue(number + 1));
    const current = previous.map((value, index) => ({ ...value, summary: `Changed ${index}`, updated: `2026-08-23T${String(index % 24).padStart(2, "0")}:00:00.000Z` }));
    const ledger = applyUpdateSnapshot(emptyUpdateLedger(), previous, current);
    expect(ledger.events).toHaveLength(MAX_UPDATE_EVENTS);
    const retained = ingestUpdateEvents(ledger, [], [current[0]!]);
    expect(retained.events.every((event) => String(event.issueId) === String(current[0]!.id))).toBe(true);
  });

  test("supports unread/all filtering and local group read state", () => {
    const previous = [issue(1), issue(2)];
    const current = [issue(1, { summary: "One changed" }), issue(2, { summary: "Two changed" })];
    let ledger = applyUpdateSnapshot(emptyUpdateLedger(), previous, current);
    expect(updateGroups(ledger, "unread")).toHaveLength(2);
    ledger = markGroupsRead(ledger, [id("1")], true, [id("1"), id("2")]);
    expect(updateGroups(ledger, "unread").map((group) => String(group.issueId))).toEqual(["2"]);
    ledger = toggleGroupRead(ledger, id("1"), [id("1"), id("2")]);
    expect(updateGroups(ledger, "unread").map((group) => String(group.issueId)).sort()).toEqual(["1", "2"]);
  });

  test("new event resets a read group, while duplicate event remains idempotent", () => {
    const previous = [issue(1)];
    const current = [issue(1, { summary: "First change", updated: "2026-08-23T11:00:00.000Z" })];
    let ledger = applyUpdateSnapshot(emptyUpdateLedger(), previous, current);
    const firstEvent = ledger.events[0]!;
    ledger = markGroupsRead(ledger, [id("1")], true, [id("1")]);
    expect(updateGroups(ledger, "unread")).toHaveLength(0);

    ledger = ingestUpdateEvents(ledger, [firstEvent], [id("1")]);
    expect(updateGroups(ledger, "unread")).toHaveLength(0);

    const second = issue(1, { summary: "Second change", updated: "2026-08-23T12:00:00.000Z" });
    const newEvent = deriveUpdateEvents(current, [second])[0]!;
    ledger = ingestUpdateEvents(ledger, [newEvent], [id("1")]);
    expect(updateGroups(ledger, "unread").map((group) => String(group.issueId))).toEqual(["1"]);
  });

  test("shows three rows by default and all rows when expanded", () => {
    const previous = [issue(1)];
    const current = [issue(1, { summary: "new", status: "In Progress", priority: "High", assignee: "Grace" })];
    let ledger = applyUpdateSnapshot(emptyUpdateLedger(), previous, current);
    expect(updateGroups(ledger)[0]?.rows).toHaveLength(DEFAULT_UPDATE_ROW_LIMIT);
    ledger = setGroupExpanded(ledger, id("1"), true);
    expect(updateGroups(ledger)[0]?.rows).toHaveLength(4);
    expect(updateGroups(ledger)[0]?.expanded).toBe(true);
  });

  test("mark all displayed validates authenticated-view membership", () => {
    const previous = [issue(1), issue(2)];
    const current = [issue(1, { summary: "One changed" }), issue(2, { summary: "Two changed" })];
    let ledger = applyUpdateSnapshot(emptyUpdateLedger(), previous, current);
    expect(() => markAllDisplayedRead(ledger, [id("999")], [id("1"), id("2")])).toThrow();
    ledger = markAllDisplayedRead(ledger, [id("1"), id("2")], [id("1"), id("2")]);
    expect(updateGroups(ledger, "unread")).toHaveLength(0);
  });

  test("newly inactive membership cannot retain events or read state", () => {
    const previous = [issue(1), issue(2)];
    const current = [issue(1, { summary: "One changed" }), issue(2, { summary: "Two changed" })];
    let ledger = applyUpdateSnapshot(emptyUpdateLedger(), previous, current);
    ledger = markGroupsRead(ledger, [id("2")], true);
    ledger = setGroupExpanded(ledger, id("2"), true);
    ledger = ingestUpdateEvents(ledger, [], [id("1")]);
    expect(ledger.events.every((event) => String(event.issueId) === "1")).toBe(true);
    expect(ledger.readIssueIds).toEqual([]);
    expect(ledger.expandedIssueIds).toEqual([]);
  });
});
