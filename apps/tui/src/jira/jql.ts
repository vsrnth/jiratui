import { JiraError } from "./errors";
import { parseTeamAccountId } from "../domain";

export const MAX_JQL_SCOPE_BYTES = 2_000;
export const MAX_TEAM_ACCOUNT_IDS = 100;

export function assignedOrWatchedJql(scope?: string): string {
  const membership = "(assignee = currentUser() OR watcher = currentUser())";
  const normalized = scope?.trim() ?? "";
  if (normalized.length === 0) return `${membership} ORDER BY updated DESC`;
  if (
    new TextEncoder().encode(normalized).length > MAX_JQL_SCOPE_BYTES ||
    /order\s+by/i.test(normalized) ||
    [...normalized].some((char) => /[\u0000-\u001f\u007f]/u.test(char))
  ) {
    throw new JiraError("invalid_input", "Jira scope is invalid");
  }
  return `(${normalized}) AND ${membership} ORDER BY updated DESC`;
}

/** Build the fixed, assignee-only query used by the isolated Team tracker. */
export function teamIssuesJql(accountIds: readonly string[]): string {
  if (!Array.isArray(accountIds) || accountIds.length === 0 || accountIds.length > MAX_TEAM_ACCOUNT_IDS) {
    throw new JiraError("invalid_input", "Team member account IDs are invalid");
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of accountIds) {
    let accountId: string;
    try {
      accountId = parseTeamAccountId(value);
    } catch {
      throw new JiraError("invalid_input", "Team member account IDs are invalid");
    }
    if (!seen.has(accountId)) {
      seen.add(accountId);
      normalized.push(accountId);
    }
  }
  if (normalized.length === 0) throw new JiraError("invalid_input", "Team member account IDs are invalid");
  return `statusCategory = "In Progress" AND assignee IN (${normalized.map((accountId) => `"${accountId}"`).join(", ")}) ORDER BY updated DESC`;
}
