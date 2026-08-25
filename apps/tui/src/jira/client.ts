import { parseIssueKey, parseTeamAccountId, parseTeamEmail, type IssueComment, type IssueDetail, type IssueKey, type IssueSummary, type TeamMember, type UserIdentity } from "../domain/index";
import { JiraError } from "./errors";
import { assignedOrWatchedJql, teamIssuesJql } from "./jql";
import { mapComment, mapIssueDetail, mapIssueSummary, mapMyself, mapTeamMember } from "./mapping";

export const CONNECT_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_JSON_BYTES = 16 * 1024 * 1024;
export const MAX_TENANT_INFO_BYTES = 8 * 1024;
export const MAX_CLOUD_ID_BYTES = 128;
export const SEARCH_PAGE_SIZE = 100;
export const MAX_SEARCH_PAGES = 1_000;
export const COMMENT_PAGE_SIZE = 100;
export const MAX_COMMENT_PAGES = 1_000;
export const MAX_COMMENTS = 10_000;

const ISSUE_FIELDS = [
  "summary", "status", "priority", "assignee", "updated", "created", "issuetype", "reporter", "project",
  "parent", "labels", "duedate", "description", "attachment",
];
export const MAX_SEARCH_RESULTS = 10_000;

export class ApiTokenCredentials {
  readonly email: string;

  constructor(email: string, token: string) {
    if (!email || new TextEncoder().encode(email).length > 320 || /[\u0000-\u001f\u007f]/u.test(email)) {
      throw new JiraError("invalid_input", "Jira email is invalid");
    }
    if (!token || new TextEncoder().encode(token).length > 4_096 || /[\u0000-\u001f\u007f]/u.test(token)) {
      throw new JiraError("invalid_input", "Jira API token is invalid");
    }
    this.email = email;
    credentialTokens.set(this, token);
  }

  /** Deliberately redacted so credentials cannot leak through diagnostics. */
  toJSON(): { email: string; token: "[REDACTED]" } {
    return { email: this.email, token: "[REDACTED]" };
  }

  toString(): string {
    return "[Jira credentials]";
  }

}

const credentialTokens = new WeakMap<ApiTokenCredentials, string>();

export class JiraHttpConfig {
  readonly siteUrl: URL;
  readonly cloudId: string | null;
  readonly baseUrl: URL;

  constructor(siteUrl: string | URL, cloudId?: string) {
    this.siteUrl = validateJiraBaseUrl(siteUrl);
    this.cloudId = cloudId === undefined ? null : validateCloudId(cloudId);
    this.baseUrl = this.cloudId === null ? this.siteUrl : gatewayUrl(this.cloudId);
  }

  static parse(siteUrl: string | URL, cloudId?: string): JiraHttpConfig {
    return new JiraHttpConfig(siteUrl, cloudId);
  }
}

export type SearchOptions = { scope?: string; signal?: AbortSignal };

/** Read-only Jira Cloud client. It never exposes a request body or token in errors. */
export class JiraHttpClient {
  readonly config: JiraHttpConfig;
  readonly credentials: ApiTokenCredentials;

  constructor(config: JiraHttpConfig | string | URL, credentials: ApiTokenCredentials) {
    this.config = config instanceof JiraHttpConfig ? config : new JiraHttpConfig(config);
    if (this.config.cloudId === null) throw new JiraError("invalid_input", "Jira Cloud ID is required for authenticated requests");
    this.credentials = credentials;
  }

  static from(siteUrl: string | URL, email: string, token: string, cloudId?: string): JiraHttpClient {
    return new JiraHttpClient(new JiraHttpConfig(siteUrl, cloudId), new ApiTokenCredentials(email, token));
  }

  async myself(signal?: AbortSignal): Promise<UserIdentity> {
    return mapMyself(await this.requestJson("/rest/api/3/myself", { method: "GET" }, signal));
  }

  getMyself(signal?: AbortSignal): Promise<UserIdentity> {
    return this.myself(signal);
  }

  async searchAssignedOrWatched(options: SearchOptions | string = {}): Promise<IssueSummary[]> {
    const normalized: SearchOptions = typeof options === "string" ? { scope: options } : options;
    return this.searchJql(assignedOrWatchedJql(normalized.scope), normalized.signal);
  }

  async resolveTeamMember(identifier: string, signal?: AbortSignal): Promise<TeamMember> {
    let normalized: string;
    const isEmail = typeof identifier === "string" && identifier.includes("@");
    try {
      if (typeof identifier !== "string") throw new Error("invalid identifier");
      normalized = isEmail ? parseTeamEmail(identifier) : parseTeamAccountId(identifier);
    } catch {
      throw new JiraError("invalid_input", "Team member identifier is invalid");
    }
    if (isEmail) {
      const path = `/rest/api/3/user/search?query=${encodeURIComponent(normalized)}&maxResults=2`;
      const payload = await this.requestJson(path, { method: "GET" }, signal);
      const matches = Array.isArray(payload) ? payload : [];
      const activeMatches = matches.filter((match) => payloadRecord(match).active === true);
      if (activeMatches.length !== 1) throw new JiraError("not_found", "Jira team member could not be resolved");
      return mapTeamMember(activeMatches[0]);
    }
    const path = `/rest/api/3/user?accountId=${encodeURIComponent(normalized)}`;
    return mapTeamMember(await this.requestJson(path, { method: "GET" }, signal));
  }

  async searchTeamIssues(accountIds: readonly string[], signal?: AbortSignal): Promise<IssueSummary[]> {
    return this.searchJql(teamIssuesJql(accountIds), signal);
  }

  private async searchJql(jql: string, signal?: AbortSignal): Promise<IssueSummary[]> {
    const issues: IssueSummary[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
      const body: Record<string, unknown> = { jql, maxResults: SEARCH_PAGE_SIZE, fields: ISSUE_FIELDS };
      if (nextPageToken !== undefined) body.nextPageToken = nextPageToken;
      const payload = await this.requestJson("/rest/api/3/search/jql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, signal);
      const pageIssues = arrayProperty(payload, "issues");
      if (pageIssues.length > SEARCH_PAGE_SIZE) throw new JiraError("pagination", "Jira returned an oversized issue page");
      issues.push(...pageIssues.map(mapIssueSummary));
      if (issues.length > MAX_SEARCH_RESULTS) throw new JiraError("pagination", "Jira issue result exceeded safe limits");
      const total = numberProperty(payload, "total");
      if (total !== undefined && (!Number.isSafeInteger(total) || total < 0 || total > MAX_SEARCH_RESULTS)) {
        throw new JiraError("pagination", "Jira returned an invalid issue total");
      }
      const last = payloadRecord(payload).isLast === true;
      const rawToken = payloadRecord(payload).nextPageToken;
      if (rawToken !== undefined && rawToken !== null && typeof rawToken !== "string") throw new JiraError("pagination", "Jira returned an invalid continuation token");
      const token = typeof rawToken === "string" ? rawToken : undefined;
      if (last || token === undefined || token.length === 0 || (total !== undefined && issues.length >= total)) return issues;
      if (token === nextPageToken || token.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(token)) throw new JiraError("pagination", "Jira pagination did not advance");
      nextPageToken = token;
    }
    throw new JiraError("pagination", "Jira issue pagination exceeded its limit");
  }

  searchIssues(options: SearchOptions | string = {}): Promise<IssueSummary[]> {
    return this.searchAssignedOrWatched(options);
  }

  async issueDetail(issueKey: IssueKey | string, signal?: AbortSignal): Promise<IssueDetail> {
    const key = parseIssueKey(issueKey);
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(ISSUE_FIELDS.join(","))}`;
    const issue = await this.requestJson(path, { method: "GET" }, signal);
    const comments = await this.comments(key, signal);
    return mapIssueDetail(issue, comments, true);
  }

  fetchIssueDetail(issueKey: IssueKey | string, signal?: AbortSignal): Promise<IssueDetail> {
    return this.issueDetail(issueKey, signal);
  }

  lookupIssue(issueKey: IssueKey | string, signal?: AbortSignal): Promise<IssueDetail> {
    return this.issueDetail(issueKey, signal);
  }

  async comments(issueKey: IssueKey | string, signal?: AbortSignal): Promise<IssueComment[]> {
    const key = parseIssueKey(issueKey);
    const comments: IssueComment[] = [];
    let startAt = 0;
    for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
      const path = `/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=${COMMENT_PAGE_SIZE}`;
      const payload = await this.requestJson(path, { method: "GET" }, signal);
      const response = payloadRecord(payload);
      if (!Array.isArray(response.comments)) throw new JiraError("upstream", "Jira returned an invalid comment page");
      const values = response.comments;
      if (values.length > COMMENT_PAGE_SIZE) throw new JiraError("pagination", "Jira returned an oversized comment page");
      const responseStart = numberProperty(payload, "startAt");
      if (responseStart === undefined || !Number.isSafeInteger(responseStart) || responseStart !== startAt) throw new JiraError("pagination", "Jira comment pagination did not advance");
      const total = numberProperty(payload, "total");
      if (total === undefined || !Number.isSafeInteger(total) || total < 0 || total > MAX_COMMENTS || total < startAt) throw new JiraError("pagination", "Jira returned an invalid comment total");
      comments.push(...values.map(mapComment));
      if (comments.length > MAX_COMMENTS) throw new JiraError("pagination", "Jira comments exceeded their limit");
      if (comments.length >= total) {
        if (comments.length !== total) throw new JiraError("pagination", "Jira returned an invalid comment total");
        return comments.sort(compareCommentsNewestFirst);
      }
      if (values.length === 0) throw new JiraError("pagination", "Jira comment pagination did not advance");
      const next = startAt + values.length;
      if (next <= startAt) throw new JiraError("pagination", "Jira comment pagination did not advance");
      startAt = next;
    }
    throw new JiraError("pagination", "Jira comment pagination exceeded its limit");
  }

  fetchComments(issueKey: IssueKey | string, signal?: AbortSignal): Promise<IssueComment[]> {
    return this.comments(issueKey, signal);
  }

  private async requestJson(path: string, init: RequestInit, externalSignal?: AbortSignal): Promise<unknown> {
    // A leading slash would discard `/ex/jira/{cloudId}` from the gateway origin.
    const relativePath = this.config.cloudId === null ? path : path.replace(/^\//u, "");
    const url = new URL(relativePath, this.config.baseUrl);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `Basic ${encodeBase64(`${this.credentials.email}:${credentialTokens.get(this.credentials) ?? ""}`)}`);
    const response = await fetchWithPhases(url, { ...init, headers, redirect: "error" }, externalSignal);
    if (!response.ok) throw statusError(response.status);
    return readJson(response, MAX_JSON_BYTES);
  }
}

/** Discover the tenant Cloud ID without credentials, using the validated Jira site origin. */
export async function discoverCloudId(siteUrl: string | URL, signal?: AbortSignal): Promise<string> {
  const validatedSite = validateJiraBaseUrl(siteUrl);
  const response = await fetchWithPhases(new URL("_edge/tenant_info", validatedSite), { method: "GET", headers: { accept: "application/json" }, redirect: "error" }, signal, MAX_TENANT_INFO_BYTES);
  if (!response.ok) throw statusError(response.status);
  const payload = await readJson(response, MAX_TENANT_INFO_BYTES);
  const value = payloadRecord(payload).cloudId ?? payloadRecord(payload).cloud_id;
  if (typeof value !== "string") throw new JiraError("upstream", "Jira Cloud ID was unavailable");
  return validateCloudId(value);
}

export function validateJiraBaseUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input.toString());
  } catch {
    throw new JiraError("invalid_input", "Jira URL is invalid");
  }
  const host = url.hostname.toLowerCase();
  const labels = host.split(".");
  if (
    url.protocol !== "https:" ||
    labels.length !== 3 ||
    labels[1] !== "atlassian" ||
    labels[2] !== "net" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(labels[0] ?? "") ||
    url.port !== "" || url.username !== "" || url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== ""
  ) throw new JiraError("invalid_input", "Jira URL must be an HTTPS Atlassian Cloud site");
  return new URL(`https://${host}/`);
}

export function validateCloudId(value: string): string {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).length > MAX_CLOUD_ID_BYTES ||
    !/^[A-Za-z0-9][A-Za-z0-9._~-]*$/u.test(value) ||
    value === "." || value === ".."
  ) throw new JiraError("invalid_input", "Jira Cloud ID is invalid");
  return value;
}

function gatewayUrl(cloudId: string): URL {
  return new URL(`https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/`);
}

async function fetchWithPhases(url: URL, init: RequestInit, externalSignal?: AbortSignal, maxBytes = MAX_JSON_BYTES): Promise<Response> {
  const connectController = new AbortController();
  const removeExternal = forwardAbort(externalSignal, connectController);
  const connectTimer = setTimeout(() => connectController.abort("connect_timeout"), CONNECT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: connectController.signal });
  } catch (error) {
    if (externalSignal?.aborted) throw new JiraError("cancelled", "Jira request cancelled");
    if (connectController.signal.aborted) throw new JiraError("offline", "Jira connection timed out");
    throw transportError(error);
  } finally {
    clearTimeout(connectTimer);
    removeExternal();
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    throw statusError(response.status);
  }
  const requestController = new AbortController();
  const removeRequestExternal = forwardAbort(externalSignal, requestController);
  const requestTimer = setTimeout(() => requestController.abort("request_timeout"), REQUEST_TIMEOUT_MS);
  try {
    // Reconstructing the Response is unnecessary; the body read below has the same deadline via signal.
    return await responseWithAbort(response, requestController.signal, maxBytes);
  } finally {
    clearTimeout(requestTimer);
    removeRequestExternal();
  }
}

async function responseWithAbort(response: Response, signal: AbortSignal, maxBytes: number): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw requestAbortError(signal);
      const result = await readWithAbort(reader, signal);
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maxBytes) throw new JiraError("response_too_large", "Jira response exceeded its limit");
      chunks.push(result.value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* best effort */ }
    if (error instanceof JiraError) throw error;
    throw transportError(error);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new Response(bytes, { status: response.status, headers: response.headers });
}

async function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>, signal: AbortSignal) {
  if (signal.aborted) throw requestAbortError(signal);
  let remove: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(requestAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    remove?.();
  }
}

function requestAbortError(signal: AbortSignal): JiraError {
  return signal.reason === "request_timeout"
    ? new JiraError("offline", "Jira request timed out")
    : new JiraError("cancelled", "Jira request cancelled");
}

function compareCommentsNewestFirst(left: IssueComment, right: IssueComment): number {
  const created = compareTimestamp(right.created, left.created);
  if (created !== 0) return created;
  const updated = compareTimestamp(right.updated, left.updated);
  if (updated !== 0) return updated;
  return compareCodePoints(left.id, right.id);
}

function compareTimestamp(left: string, right: string): number {
  const leftMillis = Date.parse(left);
  const rightMillis = Date.parse(right);
  if (Number.isFinite(leftMillis) && Number.isFinite(rightMillis) && leftMillis !== rightMillis) return leftMillis < rightMillis ? -1 : 1;
  return compareCodePoints(left, right);
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && Number.isFinite(Number(length)) && Number(length) > maxBytes) throw new JiraError("response_too_large", "Jira response exceeded its limit");
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    throw new JiraError("upstream", "Jira returned malformed JSON");
  }
}

function statusError(status: number): JiraError {
  if (status === 401) return new JiraError("authentication", "Jira authentication was rejected", status);
  if (status === 403) return new JiraError("authorization", "Jira authorization was rejected", status);
  if (status === 404) return new JiraError("not_found", "Jira resource was not found", status);
  if (status === 429) return new JiraError("rate_limited", "Jira rate limited the request", status);
  return new JiraError("upstream", "Jira returned an upstream error", status);
}

function transportError(error: unknown): JiraError {
  if (error instanceof JiraError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return new JiraError("offline", "Jira request timed out");
  return new JiraError("offline", "Jira is unavailable");
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  const abort = () => target.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringProperty(value: unknown, key: string): string | undefined {
  const candidate = payloadRecord(value)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function numberProperty(value: unknown, key: string): number | undefined {
  const candidate = payloadRecord(value)[key];
  return typeof candidate === "number" ? candidate : undefined;
}

function arrayProperty(value: unknown, ...keys: string[]): unknown[] {
  const object = payloadRecord(value);
  for (const key of keys) if (Array.isArray(object[key])) return object[key] as unknown[];
  return [];
}
