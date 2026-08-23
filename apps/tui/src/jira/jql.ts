import { JiraError } from "./errors";

export const MAX_JQL_SCOPE_BYTES = 2_000;

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
