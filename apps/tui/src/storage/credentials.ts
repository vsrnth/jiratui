const SERVICE = "dev.jiradesk.JiraDesk";
const USERNAME = "jira-cloud-default-v1";
const MAX_URL = 2_048;
const MAX_EMAIL = 320;
const MAX_TOKEN = 4_096;
const MAX_PAYLOAD = 16 * 1_024;

export type CredentialParts = Readonly<{ baseUrl: string; email: string; token: string; cloudId?: string; siteId?: string }>;
export type CredentialResult<T> = { kind: "ok"; value: T } | { kind: "unavailable"; message: string };
type SecretIdentity = Readonly<{ service: string; name: string }>;
type SecretWrite = SecretIdentity & Readonly<{ value: string; allowUnrestrictedAccess?: boolean }>;
export type SecretProvider = Readonly<{
  get(options: SecretIdentity): Promise<string | null>;
  set(options: SecretWrite): Promise<void>;
  delete(options: SecretIdentity): Promise<boolean>;
}>;

const nativeSecrets: SecretProvider = {
  get: (options) => Bun.secrets.get(options),
  set: (options) => Bun.secrets.set(options),
  delete: (options) => Bun.secrets.delete(options),
};

export class SavedCredentials {
  readonly #baseUrl: string;
  readonly #email: string;
  readonly #cloudId: string | undefined;
  readonly #siteId: string | undefined;
  #token: string;
  constructor(parts: CredentialParts) {
    validate(parts);
    this.#baseUrl = parts.baseUrl;
    this.#email = parts.email;
    this.#token = parts.token;
    this.#cloudId = parts.cloudId;
    this.#siteId = parts.siteId;
  }
  get baseUrl(): string { return this.#baseUrl; }
  get email(): string { return this.#email; }
  intoParts(): CredentialParts {
    const parts: { baseUrl: string; email: string; token: string; cloudId?: string; siteId?: string } = {
      baseUrl: this.#baseUrl,
      email: this.#email,
      token: this.#token,
    };
    if (this.#cloudId !== undefined) parts.cloudId = this.#cloudId;
    if (this.#siteId !== undefined) parts.siteId = this.#siteId;
    this.#token = "";
    return parts;
  }
  toJSON(): never { throw new Error("Credentials cannot be serialized"); }
  toString(): string { return "[SavedCredentials redacted]"; }
}

function validate(parts: CredentialParts): void {
  const bounded = (value: string, max: number) => value.length > 0 && value.length <= max && ![...value].some((char) => /\p{Cc}/u.test(char));
  if (!bounded(parts.baseUrl, MAX_URL) || !bounded(parts.email, MAX_EMAIL) || !bounded(parts.token, MAX_TOKEN) || /\s/u.test(parts.token)) throw new Error("Invalid credential bounds");
  if (parts.cloudId !== undefined && !bounded(parts.cloudId, 128)) throw new Error("Invalid cloud identity");
  if (parts.siteId !== undefined && !bounded(parts.siteId, 320)) throw new Error("Invalid site identity");
  if (JSON.stringify(parts).length > MAX_PAYLOAD) throw new Error("Credential payload exceeds limit");
}

/** Cross-platform OS credential store: macOS Keychain and Linux libsecret. */
export class SystemCredentialStore {
  readonly #provider: SecretProvider;

  constructor(provider: SecretProvider = nativeSecrets) {
    this.#provider = provider;
  }

  async load(): Promise<CredentialResult<SavedCredentials | null>> {
    try {
      const stored = await this.#provider.get({ service: SERVICE, name: USERNAME });
      if (stored === null) return { kind: "ok", value: null };
      const parsed: unknown = JSON.parse(stored);
      if (!parsed || typeof parsed !== "object") return { kind: "ok", value: null };
      const payload = parsed as Partial<CredentialParts> & { version?: unknown };
      if (payload.version !== 1) return { kind: "ok", value: null };
      const value = payload;
      return { kind: "ok", value: typeof value.baseUrl === "string" && typeof value.email === "string" && typeof value.token === "string" ? new SavedCredentials(value as CredentialParts) : null };
    } catch { return { kind: "unavailable", message: "Secure credential storage is unavailable" }; }
  }

  async save(credentials: CredentialParts): Promise<CredentialResult<true>> {
    try {
      validate(credentials);
      await this.#provider.set({
        service: SERVICE,
        name: USERNAME,
        value: JSON.stringify({ version: 1, ...credentials }),
        // Never weaken macOS Keychain ACLs for unattended access.
        allowUnrestrictedAccess: false,
      });
      return { kind: "ok", value: true };
    } catch { return { kind: "unavailable", message: "Secure credential storage is unavailable" }; }
  }

  async delete(): Promise<CredentialResult<true>> {
    try {
      await this.#provider.delete({ service: SERVICE, name: USERNAME });
      return { kind: "ok", value: true };
    } catch { return { kind: "unavailable", message: "Secure credential storage is unavailable" }; }
  }
}
