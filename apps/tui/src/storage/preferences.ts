import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { ensureDataDirectory } from "./cache";

export const PREFERENCES_VERSION = 1 as const;
export const PREFERENCES_FILENAME = "preferences.json";
export const MAX_PREFERENCES_BYTES = 64 * 1_024;
export const MAX_JQL_SCOPE_BYTES = 2_000;
export const MAX_TEAM_MEMBERS = 100;
export const MAX_TEAM_MEMBER_BYTES = 320;

export type ThemeMode = "System" | "Light" | "Dark";

export type Preferences = Readonly<{
  version: typeof PREFERENCES_VERSION;
  jqlScope?: string;
  teamMembers: readonly string[];
  theme: ThemeMode;
  noColor: boolean;
  asciiOnly: boolean;
}>;

/** A patch is accepted by the save API; omitted fields receive safe defaults. */
export type PreferencesInput = Readonly<{
  version?: unknown;
  jqlScope?: unknown;
  teamMembers?: unknown;
  theme?: unknown;
  noColor?: unknown;
  asciiOnly?: unknown;
}>;

export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  version: PREFERENCES_VERSION,
  teamMembers: Object.freeze([]) as readonly string[],
  theme: "System" as const,
  noColor: false,
  asciiOnly: false,
});

export type PreferencesErrorCode = "invalid" | "unsafe_path" | "io";

export class PreferencesError extends Error {
  readonly code: PreferencesErrorCode;

  constructor(code: PreferencesErrorCode, message: string) {
    super(message);
    this.name = "PreferencesError";
    this.code = code;
  }
}

const ALLOWED_FIELDS = new Set(["version", "jqlScope", "teamMembers", "theme", "noColor", "asciiOnly"]);
const CONTROL_CHARACTER = /\p{Cc}/u;
const ORDER_BY = /\border\s+by\b/iu;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PreferencesError("invalid", "Preferences must be an object");
  }
}

function assertKnownFields(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) throw new PreferencesError("invalid", `Unknown preference field: ${key}`);
  }
}

function validateText(value: string, label: string, maxBytes: number): string {
  if (CONTROL_CHARACTER.test(value)) throw new PreferencesError("invalid", `${label} contains a control character`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new PreferencesError("invalid", `${label} must not be blank`);
  if (utf8Bytes(normalized) > maxBytes) throw new PreferencesError("invalid", `${label} exceeds ${maxBytes} UTF-8 bytes`);
  return normalized;
}

function validateJql(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new PreferencesError("invalid", "jqlScope must be a string");
  if (CONTROL_CHARACTER.test(value)) throw new PreferencesError("invalid", "jqlScope contains a control character");
  const normalized = value.trim();
  if (normalized.length === 0) throw new PreferencesError("invalid", "jqlScope must not be blank");
  if (utf8Bytes(normalized) > MAX_JQL_SCOPE_BYTES) throw new PreferencesError("invalid", `jqlScope exceeds ${MAX_JQL_SCOPE_BYTES} UTF-8 bytes`);
  if (ORDER_BY.test(normalized)) throw new PreferencesError("invalid", "jqlScope must not contain ORDER BY");
  return normalized;
}

function validateTeamMembers(value: unknown): readonly string[] {
  if (value === undefined) return DEFAULT_PREFERENCES.teamMembers;
  if (!Array.isArray(value)) throw new PreferencesError("invalid", "teamMembers must be an array");
  if (value.length > MAX_TEAM_MEMBERS) throw new PreferencesError("invalid", `teamMembers exceeds ${MAX_TEAM_MEMBERS} entries`);

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new PreferencesError("invalid", "teamMembers entries must be strings");
    const member = validateText(item, "team member", MAX_TEAM_MEMBER_BYTES);
    if (!seen.has(member)) {
      seen.add(member);
      normalized.push(member);
    }
  }
  return Object.freeze(normalized);
}

/**
 * Validate and normalize an in-memory preference value.
 *
 * Missing optional fields use safe defaults. Unknown fields and invalid values
 * throw PreferencesError; loadPreferences catches those errors and returns the
 * defaults, while savePreferences exposes them to its caller.
 */
export function validatePreferences(input: unknown): Preferences {
  assertPlainObject(input);
  assertKnownFields(input);

  if (input.version !== undefined && input.version !== PREFERENCES_VERSION) {
    throw new PreferencesError("invalid", "Unsupported preferences schema version");
  }
  if (input.theme !== undefined && (input.theme !== "System" && input.theme !== "Light" && input.theme !== "Dark")) {
    throw new PreferencesError("invalid", "theme must be System, Light, or Dark");
  }
  if (input.noColor !== undefined && typeof input.noColor !== "boolean") {
    throw new PreferencesError("invalid", "noColor must be a boolean");
  }
  if (input.asciiOnly !== undefined && typeof input.asciiOnly !== "boolean") {
    throw new PreferencesError("invalid", "asciiOnly must be a boolean");
  }

  const jqlScope = validateJql(input.jqlScope);
  const result: { version: 1; jqlScope?: string; teamMembers: readonly string[]; theme: ThemeMode; noColor: boolean; asciiOnly: boolean } = {
    version: PREFERENCES_VERSION,
    teamMembers: validateTeamMembers(input.teamMembers),
    theme: (input.theme as ThemeMode | undefined) ?? DEFAULT_PREFERENCES.theme,
    noColor: (input.noColor as boolean | undefined) ?? DEFAULT_PREFERENCES.noColor,
    asciiOnly: (input.asciiOnly as boolean | undefined) ?? DEFAULT_PREFERENCES.asciiOnly,
  };
  if (jqlScope !== undefined) result.jqlScope = jqlScope;

  const encoded = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (encoded > MAX_PREFERENCES_BYTES) throw new PreferencesError("invalid", `Preferences exceed ${MAX_PREFERENCES_BYTES} bytes`);
  return Object.freeze(result);
}

function preferencesPath(env: Record<string, string | undefined>): string {
  return join(ensureDataDirectory(env), PREFERENCES_FILENAME);
}

function rejectUnsafeDestination(path: string): void {
  if (!isRegularOrMissing(path)) throw new PreferencesError("unsafe_path", "Preferences destination must be a regular file");
}

function isRegularOrMissing(path: string): boolean {
  if (!existsSync(path)) return true;
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new PreferencesError("unsafe_path", "Preferences file cannot be a symlink");
  return info.isFile();
}

function readPreferencesFile(path: string): Preferences {
  let descriptor: number | undefined;
  try {
    const optionalFlags = fsConstants as typeof fsConstants & { O_CLOEXEC?: number; O_NOFOLLOW?: number };
    descriptor = openSync(path, fsConstants.O_RDONLY | (optionalFlags.O_NOFOLLOW ?? 0) | (optionalFlags.O_CLOEXEC ?? 0));
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new PreferencesError("unsafe_path", "Preferences file must be a regular file");
    if (info.size > MAX_PREFERENCES_BYTES) return DEFAULT_PREFERENCES;

    // Read one byte beyond the cap so a file that grows after fstat cannot be
    // accepted merely because its initial size was within bounds.
    const bytes = Buffer.alloc(MAX_PREFERENCES_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_PREFERENCES_BYTES) return DEFAULT_PREFERENCES;
    return validatePreferences(JSON.parse(bytes.subarray(0, offset).toString("utf8")) as unknown);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return DEFAULT_PREFERENCES;
    if (code === "ELOOP") throw new PreferencesError("unsafe_path", "Preferences file cannot be a symlink");
    if (error instanceof PreferencesError && error.code === "unsafe_path") throw error;
    return DEFAULT_PREFERENCES;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort cleanup */ }
    }
  }
}

/** Load preferences, defaulting safely when the file is missing or malformed. */
export function loadPreferences(env: Record<string, string | undefined> = process.env): Preferences {
  return readPreferencesFile(preferencesPath(env));
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    const flags = fsConstants.O_RDONLY | ((fsConstants as { O_DIRECTORY?: number }).O_DIRECTORY ?? 0);
    descriptor = openSync(path, flags);
    try { fsyncSync(descriptor); } catch { /* Directory fsync is not available on every supported filesystem. */ }
  } catch { /* Directory fsync is best effort where the platform permits it. */ }
  finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new PreferencesError("io", "Unable to write preferences");
    offset += written;
  }
  if (offset !== bytes.byteLength) throw new PreferencesError("io", "Preferences write was incomplete");
}

/** Validate and atomically persist preferences with owner-only permissions. */
export function savePreferences(input: unknown, env: Record<string, string | undefined> = process.env): Preferences {
  const normalized = validatePreferences(input);
  const directory = ensureDataDirectory(env);
  const destination = join(directory, PREFERENCES_FILENAME);
  rejectUnsafeDestination(destination);

  const bytes = Buffer.from(JSON.stringify(normalized) + "\n", "utf8");
  if (bytes.byteLength > MAX_PREFERENCES_BYTES) throw new PreferencesError("invalid", `Preferences exceed ${MAX_PREFERENCES_BYTES} bytes`);

  let temporaryPath: string | undefined;
  let descriptor: number | undefined;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = join(directory, `.${PREFERENCES_FILENAME}.${crypto.randomUUID()}.tmp`);
      try {
        const optionalFlags = fsConstants as typeof fsConstants & { O_CLOEXEC?: number };
        descriptor = openSync(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (optionalFlags.O_CLOEXEC ?? 0), 0o600);
        temporaryPath = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 7) throw error;
      }
    }
    if (descriptor === undefined || temporaryPath === undefined) throw new PreferencesError("io", "Unable to create preferences temporary file");
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    // Re-check immediately before replacement. A symlink is never accepted as
    // the destination, even though rename itself does not follow it.
    rejectUnsafeDestination(destination);
    renameSync(temporaryPath, destination);
    temporaryPath = undefined;
    syncDirectory(directory);
    return normalized;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort cleanup */ }
    }
    if (temporaryPath !== undefined) {
      try { unlinkSync(temporaryPath); } catch { /* only the explicit temporary leaf is cleaned */ }
    }
    if (error instanceof PreferencesError) throw error;
    throw new PreferencesError("io", error instanceof Error ? error.message : "Unable to save preferences");
  }
}

export class PreferencesStore {
  readonly #env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.#env = env;
  }

  load(): Preferences { return loadPreferences(this.#env); }
  save(input: unknown): Preferences { return savePreferences(input, this.#env); }
}
