import { parseIssueKey, type IssueDetail, type IssueKey, type IssueSummary, type UserIdentity } from "../domain";
import { IssueCache, type CacheIdentity, validateCacheIdentity } from "../storage/cache";
import type { JiraReadPort, WorkspaceConfig } from "./ports";

export class WorkspaceError extends Error {
  readonly code: "invalid_input" | "authentication" | "authorization" | "storage" | "transport" | "not_found";
  readonly cause?: unknown;
  constructor(code: WorkspaceError["code"], message: string, cause?: unknown) { super(message); this.name = "WorkspaceError"; this.code = code; this.cause = cause; }
}

export type WorkspaceSnapshot = Readonly<{
  siteLabel: string;
  identity: UserIdentity;
  issues: readonly IssueSummary[];
  source: "cache" | "jira";
  refreshedAt: string;
}>;

/** Framework-free read façade. It never exposes the transport credential. */
export class Workspace {
  readonly #jira: JiraReadPort;
  readonly #cache: IssueCache;
  readonly #config: WorkspaceConfig;
  readonly #identity: UserIdentity;
  readonly #cacheIdentity: CacheIdentity;
  readonly #siteLabel: string;
  #snapshot: IssueSummary[];

  private constructor(jira: JiraReadPort, cache: IssueCache, config: WorkspaceConfig, identity: UserIdentity, cacheIdentity: CacheIdentity, cached: IssueSummary[]) {
    this.#jira = jira; this.#cache = cache; this.#config = config; this.#identity = identity; this.#cacheIdentity = cacheIdentity;
    this.#siteLabel = config.siteLabel?.trim() || config.siteId;
    this.#snapshot = cached;
  }

  /** Verify /myself before deriving the account-scoped partition or loading it. */
  static async connect(jira: JiraReadPort, cache: IssueCache, config: WorkspaceConfig, signal?: AbortSignal): Promise<Workspace> {
    if (!config.siteId.trim()) throw new WorkspaceError("invalid_input", "Site identity is required");
    let identity: UserIdentity;
    try { identity = await jira.myself(signal); } catch (error) { throw new WorkspaceError("authentication", "Jira identity verification failed", error); }
    if (!identity.accountId?.trim()) throw new WorkspaceError("authentication", "Jira did not return an account identity");
    const cacheIdentity = validateCacheIdentity(config.siteId, identity.accountId);
    let cached: IssueSummary[];
    try { cached = cache.load(cacheIdentity); } catch { throw new WorkspaceError("storage", "Unable to load the local cache"); }
    return new Workspace(jira, cache, config, identity, cacheIdentity, cached);
  }

  get siteLabel(): string { return this.#siteLabel; }
  get identity(): UserIdentity { return this.#identity; }
  cachedSnapshot(): readonly IssueSummary[] { return this.#snapshot.slice(); }
  initialSnapshot(): WorkspaceSnapshot { return this.snapshot("cache"); }

  async refresh(scope: string | undefined = this.#config.scope, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
    let issues: readonly IssueSummary[];
    try {
      const options: { scope?: string; signal?: AbortSignal } = {};
      if (scope !== undefined) options.scope = scope;
      if (signal !== undefined) options.signal = signal;
      issues = await this.#jira.searchAssignedOrWatched(options);
    } catch (error) { throw new WorkspaceError("transport", "Unable to refresh assigned-or-watched issues", error); }
    try { this.#cache.replace(this.#cacheIdentity, issues); } catch { throw new WorkspaceError("storage", "Unable to save the local cache"); }
    this.#snapshot = issues.slice();
    return this.snapshot("jira");
  }

  async detail(issueKey: string, remote = false, signal?: AbortSignal): Promise<IssueDetail> {
    let key: IssueKey;
    try { key = parseIssueKey(issueKey); } catch { throw new WorkspaceError("invalid_input", "Issue key must look like PROJECT-123"); }
    if (!remote && !this.#snapshot.some((issue) => issue.key === key)) throw new WorkspaceError("not_found", "Issue is not in the cached workspace");
    try {
      const detail = await this.#jira.issueDetail(key, signal);
      return { ...detail, remote };
    } catch (error) { throw new WorkspaceError("transport", `Unable to load ${key}`, error); }
  }

  private snapshot(source: "cache" | "jira"): WorkspaceSnapshot {
    return { siteLabel: this.#siteLabel, identity: this.#identity, issues: this.#snapshot.slice(), source, refreshedAt: new Date().toISOString() };
  }
}
