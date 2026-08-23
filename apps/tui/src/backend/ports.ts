import type { IssueDetail, IssueKey, IssueSummary, UserIdentity } from "../domain";

/** The narrow Jira read surface consumed by the application façade. */
export interface JiraReadPort {
  myself(signal?: AbortSignal): Promise<UserIdentity>;
  searchAssignedOrWatched(options?: { scope?: string; signal?: AbortSignal } | string): Promise<readonly IssueSummary[]>;
  issueDetail(issueKey: IssueKey | string, signal?: AbortSignal): Promise<IssueDetail>;
}

export type WorkspaceConfig = Readonly<{ siteId: string; siteLabel?: string; scope?: string }>;
