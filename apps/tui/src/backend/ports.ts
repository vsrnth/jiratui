import type { IssueDetail, IssueKey, IssueSummary, TeamMember, UserIdentity } from "../domain";

/** The narrow Jira read surface consumed by the application façade. */
export interface JiraReadPort {
  myself(signal?: AbortSignal): Promise<UserIdentity>;
  searchAssignedOrWatched(options?: { scope?: string; signal?: AbortSignal } | string): Promise<readonly IssueSummary[]>;
  issueDetail(issueKey: IssueKey | string, signal?: AbortSignal): Promise<IssueDetail>;
}

/** Additional read surface required by the isolated Team tracker. */
export interface JiraTeamReadPort {
  resolveTeamMember(identifier: string, signal?: AbortSignal): Promise<TeamMember>;
  searchTeamIssues(accountIds: readonly string[], signal?: AbortSignal): Promise<readonly IssueSummary[]>;
}

export type WorkspaceConfig = Readonly<{ siteId: string; siteLabel?: string; scope?: string }>;
