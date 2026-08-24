import { parseTeamAccountId, type IssueSummary, type TeamMember } from "../domain";
import { teamPartitionSiteId, validateCacheIdentity, type CacheIdentity, type IssueCache } from "../storage/cache";
import { emptyUpdateLedger } from "../updates/ledger";
import type { JiraTeamReadPort } from "./ports";

/** Errors raised by the isolated team read façade. Details are intentionally bounded. */
export class TeamWorkspaceError extends Error {
  readonly code: "invalid_input" | "storage" | "transport" | "cancelled";
  readonly cause?: unknown;

  constructor(code: TeamWorkspaceError["code"], message: string, cause?: unknown) {
    super(message);
    this.name = "TeamWorkspaceError";
    this.code = code;
    this.cause = cause;
  }
}

export type TeamSnapshot = Readonly<{
  issues: readonly IssueSummary[];
  source: "cache" | "jira" | "local";
  refreshedAt: string;
}>;

export type TeamWorkspaceConfig = Readonly<{
  siteId: string;
  accountId: string;
  memberAccountIds: readonly string[];
}>;

/** An inactive, already committed team replacement. Activation is synchronous. */
export type TeamMemberCandidate = Readonly<{
  workspace: TeamWorkspace;
  accountIds: readonly string[];
  cacheIdentity: CacheIdentity;
  snapshot: TeamSnapshot;
}>;

/**
 * Read-only team tracker. It has its own cache identity and never reads or
 * writes the primary workspace update ledger.
 */
export class TeamWorkspace {
  readonly #jira: JiraTeamReadPort;
  readonly #cache: IssueCache;
  readonly #siteId: string;
  readonly #accountId: string;
  #accountIds: string[];
  #cacheIdentity: CacheIdentity;
  #issues: IssueSummary[];
  #source: TeamSnapshot["source"];
  #refreshedAt: string;

  private constructor(
    jira: JiraTeamReadPort,
    cache: IssueCache,
    config: TeamWorkspaceConfig,
    accountIds: readonly string[],
    cacheIdentity: CacheIdentity,
    issues: readonly IssueSummary[],
    source: TeamSnapshot["source"],
    refreshedAt: string,
  ) {
    this.#jira = jira;
    this.#cache = cache;
    this.#siteId = config.siteId.trim();
    this.#accountId = config.accountId.trim();
    this.#accountIds = [...accountIds];
    this.#cacheIdentity = cacheIdentity;
    this.#issues = issues.slice();
    this.#source = source;
    this.#refreshedAt = refreshedAt;
  }

  /** Load the canonical persisted team set and cache without contacting Jira. */
  static connect(jira: JiraTeamReadPort, cache: IssueCache, config: TeamWorkspaceConfig, signal?: AbortSignal): TeamWorkspace {
    if (!config.siteId.trim() || !config.accountId.trim()) throw new TeamWorkspaceError("invalid_input", "Team workspace identity is required");
    const accountIds = normalizeAccountIds(config.memberAccountIds);
    throwIfAborted(signal);
    const cacheIdentity = makeCacheIdentity(config.siteId, config.accountId, accountIds);
    let cached: ReturnType<IssueCache["loadWorkspace"]>;
    try {
      cached = cache.loadWorkspace(cacheIdentity);
      // Empty teams are a local no-op. Clear an accidental stale partition so
      // an old team can never leak into the explicitly empty team view.
      if (accountIds.length === 0 && cached.issues.length > 0) {
        const committed = cache.commitWorkspace(cacheIdentity, [], emptyUpdateLedger(), true);
        cached = { ...cached, issues: committed.issues, updates: committed.updates, baselineEstablished: committed.baselineEstablished };
      }
    } catch (error) {
      throw new TeamWorkspaceError("storage", "Unable to load the local team cache", error);
    }
    return new TeamWorkspace(
      jira,
      cache,
      config,
      accountIds,
      cacheIdentity,
      accountIds.length === 0 ? [] : cached.issues,
      accountIds.length === 0 ? "local" : "cache",
      new Date().toISOString(),
    );
  }

  memberAccountIds(): readonly string[] { return this.#accountIds.slice(); }

  snapshot(): TeamSnapshot {
    return { issues: this.#issues.slice(), source: this.#source, refreshedAt: this.#refreshedAt };
  }

  initialSnapshot(): TeamSnapshot { return this.snapshot(); }

  async refresh(signal?: AbortSignal): Promise<TeamSnapshot> {
    throwIfAborted(signal);
    if (this.#accountIds.length === 0) {
      this.commit([], true);
      this.#source = "local";
      this.#refreshedAt = new Date().toISOString();
      return this.snapshot();
    }

    let issues: readonly IssueSummary[];
    try {
      issues = await this.#jira.searchTeamIssues(this.#accountIds, signal);
    } catch (error) {
      if (signal?.aborted) throw new TeamWorkspaceError("cancelled", "Team refresh cancelled");
      throw new TeamWorkspaceError("transport", "Unable to refresh team issues", error);
    }
    throwIfAborted(signal);
    this.commit(issues, true);
    this.#source = "jira";
    this.#refreshedAt = new Date().toISOString();
    return this.snapshot();
  }

  /** Resolve, fetch, and atomically commit an inactive member set. */
  async prepareTeamMembers(identifiers: readonly string[], signal?: AbortSignal): Promise<TeamMemberCandidate> {
    const rawIdentifiers = validateRawIdentifiers(identifiers);
    throwIfAborted(signal);

    const members: TeamMember[] = [];
    const seen = new Set<string>();
    for (const identifier of rawIdentifiers) {
      throwIfAborted(signal);
      let member: TeamMember;
      try {
        member = await this.#jira.resolveTeamMember(identifier, signal);
      } catch (error) {
        if (signal?.aborted) throw new TeamWorkspaceError("cancelled", "Team member preparation cancelled");
        throw new TeamWorkspaceError("transport", "Unable to resolve a team member", error);
      }
      let accountId: string;
      try { accountId = parseTeamAccountId(member.accountId); }
      catch (error) { throw new TeamWorkspaceError("invalid_input", "Jira returned an invalid team member", error); }
      if (seen.has(accountId)) continue;
      seen.add(accountId);
      members.push({ ...member, accountId });
    }

    const accountIds = members.map((member) => member.accountId);
    const cacheIdentity = makeCacheIdentity(this.#siteId, this.#accountId, accountIds);
    let issues: readonly IssueSummary[] = [];
    if (accountIds.length > 0) {
      try {
        issues = await this.#jira.searchTeamIssues(accountIds, signal);
      } catch (error) {
        if (signal?.aborted) throw new TeamWorkspaceError("cancelled", "Team member preparation cancelled");
        throw new TeamWorkspaceError("transport", "Unable to load team issues", error);
      }
      throwIfAborted(signal);
    }
    let committed: ReturnType<IssueCache["commitWorkspace"]>;
    try { committed = this.#cache.commitWorkspace(cacheIdentity, issues, emptyUpdateLedger(), true); }
    catch (error) { throw new TeamWorkspaceError("storage", "Unable to save the local team cache", error); }
    return {
      workspace: this,
      accountIds: accountIds.slice(),
      cacheIdentity,
      snapshot: { issues: committed.issues.slice(), source: accountIds.length === 0 ? "local" : "jira", refreshedAt: new Date().toISOString() },
    };
  }

  /** Activate only a candidate produced by this workspace. */
  activateTeamMembers(candidate: TeamMemberCandidate): TeamSnapshot {
    if (candidate.workspace !== this) throw new TeamWorkspaceError("invalid_input", "Team candidate does not belong to this workspace");
    const expected = makeCacheIdentity(this.#siteId, this.#accountId, candidate.accountIds);
    if (candidate.cacheIdentity.siteId !== expected.siteId || candidate.cacheIdentity.accountId !== expected.accountId) {
      throw new TeamWorkspaceError("invalid_input", "Team candidate does not belong to this workspace");
    }
    this.#accountIds = [...candidate.accountIds];
    this.#cacheIdentity = candidate.cacheIdentity;
    this.#issues = candidate.snapshot.issues.slice();
    this.#source = candidate.accountIds.length === 0 ? "local" : candidate.snapshot.source;
    this.#refreshedAt = candidate.snapshot.refreshedAt;
    return this.snapshot();
  }

  private commit(issues: readonly IssueSummary[], baselineEstablished: boolean): void {
    let committed: ReturnType<IssueCache["commitWorkspace"]>;
    try { committed = this.#cache.commitWorkspace(this.#cacheIdentity, issues, emptyUpdateLedger(), baselineEstablished); }
    catch (error) { throw new TeamWorkspaceError("storage", "Unable to save the local team cache", error); }
    this.#issues = committed.issues.slice();
  }

}

function validateRawIdentifiers(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 100) throw new TeamWorkspaceError("invalid_input", "Team members are invalid");
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || /\p{Cc}/u.test(value)) throw new TeamWorkspaceError("invalid_input", "Team members are invalid");
    const identifier = value.trim();
    if (!identifier || new TextEncoder().encode(identifier).byteLength > 320) throw new TeamWorkspaceError("invalid_input", "Team members are invalid");
    if (!seen.has(identifier)) { seen.add(identifier); normalized.push(identifier); }
  }
  return normalized;
}

function normalizeAccountIds(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 100) throw new TeamWorkspaceError("invalid_input", "Team members are invalid");
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    try {
      const accountId = parseTeamAccountId(value);
      if (!seen.has(accountId)) { seen.add(accountId); normalized.push(accountId); }
    } catch (error) { throw new TeamWorkspaceError("invalid_input", "Team members are invalid", error); }
  }
  return normalized;
}

function makeCacheIdentity(siteId: string, accountId: string, accountIds: readonly string[]): CacheIdentity {
  try { return validateCacheIdentity(teamPartitionSiteId(siteId, accountIds), accountId); }
  catch (error) { throw new TeamWorkspaceError("invalid_input", "Team cache identity is invalid", error); }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new TeamWorkspaceError("cancelled", "Team operation cancelled");
}
