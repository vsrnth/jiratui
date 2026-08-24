import { discoverCloudId, JiraHttpClient, JiraHttpConfig } from "../jira";
import { isJiraError, type JiraError, type JiraErrorCategory } from "../jira/errors";
import { IssueCache } from "../storage/cache";
import { SystemCredentialStore, type CredentialParts } from "../storage/credentials";
import { PreferencesStore, PreferencesError, type Preferences } from "../storage/preferences";
import { Workspace, WorkspaceError, type WorkspaceSnapshot } from "./workspace";
import type { JiraReadPort } from "./ports";
import type { IssueDetail, IssueSummary } from "../domain";
import type { UpdateLedger } from "../updates/ledger";

export type BackendCredentials = Readonly<{ baseUrl: string; email: string; token: string; remember: boolean; cloudId?: string; siteId?: string }>;
export type BackendSnapshot = Readonly<{
  siteLabel: string;
  identity: string;
  issues: readonly IssueSummary[];
  updates: UpdateLedger;
  updatesBaselineEstablished: boolean;
  source: "cache" | "jira";
  refreshedAt: string;
  warning?: string;
}>;
export type BackendBootstrap = { state: "onboarding_required"; warning?: string } | { state: "authenticated"; snapshot: BackendSnapshot };
export type BackendFailureCategory = JiraErrorCategory | "storage" | "internal";

export class BackendError extends Error {
  readonly category: BackendFailureCategory;
  readonly cause?: unknown;
  constructor(category: BackendFailureCategory, message: string, cause?: unknown) { super(message); this.name = "BackendError"; this.category = category; this.cause = cause; }
}

type Dependencies = Readonly<{
  cache?: IssueCache;
  credentials?: SystemCredentialStore;
  preferences?: PreferencesStore;
  env?: Record<string, string | undefined>;
  jiraFactory?: (baseUrl: string, email: string, token: string, cloudId: string) => JiraReadPort;
  cloudIdDiscovery?: (baseUrl: string, signal?: AbortSignal) => Promise<string>;
}>;

/** Application adapter exposed to the renderer. It owns Jira, cache, and keyring coordination. */
export class JiraDeskBackend {
  readonly #cache: IssueCache;
  readonly #credentialStore: SystemCredentialStore;
  readonly #preferences: PreferencesStore;
  readonly #env: Record<string, string | undefined>;
  readonly #jiraFactory: (baseUrl: string, email: string, token: string, cloudId: string) => JiraReadPort;
  readonly #cloudIdDiscovery: (baseUrl: string, signal?: AbortSignal) => Promise<string>;
  #workspace: Workspace | null = null;

  constructor(dependencies: Dependencies = {}) {
    try { this.#cache = dependencies.cache ?? IssueCache.openDefault(dependencies.env); } catch (error) { throw new BackendError("storage", "Unable to open the local cache", error); }
    this.#credentialStore = dependencies.credentials ?? new SystemCredentialStore();
    this.#env = dependencies.env ?? process.env;
    this.#preferences = dependencies.preferences ?? new PreferencesStore(this.#env);
    this.#jiraFactory = dependencies.jiraFactory ?? ((baseUrl, email, token, cloudId) => JiraHttpClient.from(baseUrl, email, token, cloudId));
    this.#cloudIdDiscovery = dependencies.cloudIdDiscovery ?? discoverCloudId;
  }

  async bootstrap(): Promise<BackendBootstrap> {
    const envCredentials = this.environmentCredentials();
    if (envCredentials) return { state: "authenticated", snapshot: await this.connect(envCredentials) };
    if (this.hasPartialEnvironment()) throw new BackendError("invalid_input", "Jira environment configuration is incomplete");
    const saved = await this.#credentialStore.load();
    if (saved.kind === "unavailable") return { state: "onboarding_required", warning: saved.message };
    if (!saved.value) return { state: "onboarding_required" };
    const parts = saved.value.intoParts();
    try { return { state: "authenticated", snapshot: await this.connect({ ...parts, remember: false }) }; } catch (error) {
      return { state: "onboarding_required", warning: safeErrorMessage(error) };
    }
  }

  async connect(credentials: BackendCredentials, signal?: AbortSignal): Promise<BackendSnapshot> {
    if (!credentials.email || !credentials.token) throw new BackendError("invalid_input", "Email and API token are required");
    throwIfAborted(signal);
    let siteConfig: JiraHttpConfig;
    try { siteConfig = JiraHttpConfig.parse(credentials.baseUrl); } catch (error) { throw mapError(error); }
    let cloudId: string;
    try { cloudId = credentials.cloudId ?? await this.#cloudIdDiscovery(siteConfig.siteUrl.href, signal); } catch (error) { if (signal?.aborted) throw cancelledError(); throw mapError(error, "Jira Cloud ID could not be discovered"); }
    throwIfAborted(signal);
    let config: JiraHttpConfig;
    try { config = JiraHttpConfig.parse(credentials.baseUrl, cloudId); } catch (error) { throw mapError(error); }
    const siteId = credentials.siteId?.trim() || config.siteUrl.hostname;
    let jira: JiraReadPort;
    try { jira = this.#jiraFactory(credentials.baseUrl, credentials.email, credentials.token, cloudId); } catch (error) { throw mapError(error); }
    throwIfAborted(signal);
    let workspace: Workspace;
    try { workspace = await Workspace.connect(jira, this.#cache, { siteId, siteLabel: siteId }, signal); } catch (error) { if (signal?.aborted) throw cancelledError(); throw mapWorkspaceError(error); }
    throwIfAborted(signal);
    const storedCredentials: CredentialParts = { baseUrl: credentials.baseUrl, email: credentials.email, token: credentials.token, siteId, cloudId };
    let snapshot = toBackendSnapshot(workspace.initialSnapshot());
    if (snapshot.issues.length === 0) {
      try { snapshot = toBackendSnapshot(await workspace.refresh(undefined, signal)); } catch (error) { if (signal?.aborted) throw cancelledError(); throw mapWorkspaceError(error); }
    }
    throwIfAborted(signal);
    if (credentials.remember) {
      throwIfAborted(signal);
      const saved = await this.#credentialStore.save(storedCredentials);
      throwIfAborted(signal);
      if (saved.kind === "unavailable") snapshot = { ...snapshot, warning: "Connected, but secure login could not be saved" };
    }
    throwIfAborted(signal);
    this.#workspace = workspace;
    return snapshot;
  }

  async refresh(signal?: AbortSignal): Promise<BackendSnapshot> {
    if (!this.#workspace) throw new BackendError("authentication", "Connect to Jira first");
    try { return toBackendSnapshot(await this.#workspace.refresh(undefined, signal)); } catch (error) {
      if (signal?.aborted) throw cancelledError();
      throw mapWorkspaceError(error);
    }
  }

  persistUpdateLedger(ledger: UpdateLedger): UpdateLedger {
    if (!this.#workspace) throw new BackendError("authentication", "Connect to Jira first");
    try { return this.#workspace.persistUpdateLedger(ledger); } catch (error) { throw mapWorkspaceError(error); }
  }

  async loadDetail(issueKey: string, remote = false, signal?: AbortSignal): Promise<IssueDetail> {
    if (!this.#workspace) throw new BackendError("authentication", "Connect to Jira first");
    try { return await this.#workspace.detail(issueKey, remote, signal); } catch (error) { throw mapWorkspaceError(error); }
  }

  async forgetSavedLogin(): Promise<void> {
    const result = await this.#credentialStore.delete();
    if (result.kind === "unavailable") throw new BackendError("storage", result.message);
  }

  loadPreferences(): Preferences {
    try { return this.#preferences.load(); } catch (error) { throw mapPreferencesError(error, "load"); }
  }

  saveAppearancePreferences(input: { theme: "System" | "Light" | "Dark"; noColor: boolean; asciiOnly: boolean }): Preferences {
    try {
      const current = this.#preferences.load();
      return this.#preferences.save({
        version: current.version,
        jqlScope: current.jqlScope,
        teamMembers: current.teamMembers,
        theme: input.theme,
        noColor: input.noColor,
        asciiOnly: input.asciiOnly,
      });
    } catch (error) { throw mapPreferencesError(error, "save"); }
  }

  close(): void { this.#workspace = null; this.#cache.close(); }

  private environmentCredentials(): BackendCredentials | null {
    const baseUrl = this.#env.JIRA_BASE_URL; const email = this.#env.JIRA_EMAIL; const token = this.#env.JIRA_API_TOKEN;
    const cloudId = this.#env.JIRA_CLOUD_ID; const siteId = this.#env.JIRA_SITE_ID;
    if (!baseUrl || !email || !token || !cloudId || !siteId) return null;
    return { baseUrl, email, token, cloudId, siteId, remember: false };
  }

  private hasPartialEnvironment(): boolean {
    return ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_SITE_ID", "JIRA_CLOUD_ID"].some((key) => Boolean(this.#env[key])) && !this.environmentCredentials();
  }
}

function toBackendSnapshot(snapshot: WorkspaceSnapshot): BackendSnapshot {
  return {
    siteLabel: snapshot.siteLabel,
    identity: snapshot.identity.displayName,
    issues: snapshot.issues,
    updates: snapshot.updates,
    updatesBaselineEstablished: snapshot.updatesBaselineEstablished,
    source: snapshot.source,
    refreshedAt: snapshot.refreshedAt,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

function cancelledError(): BackendError {
  return new BackendError("cancelled", "Connection cancelled");
}

function mapWorkspaceError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof WorkspaceError) return error.cause ? mapError(error.cause, error.message) : new BackendError(error.code === "transport" ? "upstream" : error.code, error.message, error);
  return mapError(error);
}

function mapError(error: unknown, fallback = "Jira request failed"): BackendError {
  if (isJiraError(error)) return new BackendError(error.category, safeJiraMessage(error), error);
  if (error instanceof BackendError) return error;
  return new BackendError("internal", fallback, error);
}

function mapPreferencesError(error: unknown, operation: "load" | "save"): BackendError {
  if (error instanceof PreferencesError) {
    if (error.code === "invalid") return new BackendError("invalid_input", "Preferences are invalid");
    return new BackendError("storage", "Unable to access local preferences");
  }
  return new BackendError("internal", operation === "load" ? "Unable to load preferences" : "Unable to save preferences");
}

function safeJiraMessage(error: JiraError): string {
  if (error.category === "authentication") return "Jira authentication was rejected";
  if (error.category === "authorization") return "Jira authorization was rejected";
  return error.message;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof BackendError) return error.message;
  if (isJiraError(error)) return safeJiraMessage(error);
  return "Saved login could not be used";
}
