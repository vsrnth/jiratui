import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PREFERENCES,
  MAX_JQL_SCOPE_BYTES,
  MAX_PREFERENCES_BYTES,
  MAX_TEAM_MEMBER_BYTES,
  PreferencesError,
  loadPreferences,
  savePreferences,
  validatePreferences,
} from "../src/storage/preferences";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
});

function environment(): { root: string; env: Record<string, string | undefined> } {
  const root = `/tmp/jira-desk-preferences-${crypto.randomUUID()}`;
  mkdirSync(root, { recursive: true });
  temporary.push(root);
  return { root, env: { XDG_DATA_HOME: root } };
}

function pathFor(root: string): string {
  return join(root, "jira-desk", "preferences.json");
}

describe("preference validation", () => {
  test("normalizes and deduplicates team identifiers in first-input order", () => {
    expect(validatePreferences({
      jqlScope: "  project = DEV  ",
      teamMembers: [" ada ", "grace", "ada", "grace"],
      theme: "Dark",
      noColor: true,
      asciiOnly: true,
    })).toEqual({
      version: 1,
      jqlScope: "project = DEV",
      teamMembers: ["ada", "grace"],
      theme: "Dark",
      noColor: true,
      asciiOnly: true,
    });
  });

  test("enforces JQL and team byte/control bounds", () => {
    expect(() => validatePreferences({ jqlScope: "project = DEV ORDER BY updated DESC" })).toThrow(PreferencesError);
    expect(() => validatePreferences({ jqlScope: "x".repeat(MAX_JQL_SCOPE_BYTES + 1) })).toThrow(PreferencesError);
    expect(() => validatePreferences({ jqlScope: "project = DEV\n" })).toThrow(PreferencesError);
    expect(() => validatePreferences({ teamMembers: ["x".repeat(MAX_TEAM_MEMBER_BYTES + 1)] })).toThrow(PreferencesError);
    expect(() => validatePreferences({ teamMembers: ["\u0000member"] })).toThrow(PreferencesError);
    expect(() => validatePreferences({ teamMembers: Array.from({ length: 101 }, (_, index) => String(index)) })).toThrow(PreferencesError);
    expect(() => validatePreferences({ unexpected: true })).toThrow(PreferencesError);
    expect(() => validatePreferences({ version: 2 })).toThrow(PreferencesError);
  });
});

describe("preference persistence", () => {
  test("defaults when the file is missing and round-trips the bounded schema", () => {
    const { root, env } = environment();
    expect(loadPreferences(env)).toEqual(DEFAULT_PREFERENCES);
    const saved = savePreferences({ jqlScope: "project = DEV", teamMembers: ["ada", "ada"], theme: "Light", noColor: false, asciiOnly: true }, env);
    expect(saved.version).toBe(1);
    expect(loadPreferences(env)).toEqual({ version: 1, jqlScope: "project = DEV", teamMembers: ["ada"], theme: "Light", noColor: false, asciiOnly: true });
    expect(statSync(pathFor(root)).mode & 0o777).toBe(0o600);
  });

  test("defaults safely for oversized and malformed or unknown files", () => {
    const { root, env } = environment();
    const file = pathFor(root);
    mkdirSync(join(root, "jira-desk"), { recursive: true });
    writeFileSync(file, "x".repeat(MAX_PREFERENCES_BYTES + 1), { mode: 0o600 });
    expect(loadPreferences(env)).toEqual(DEFAULT_PREFERENCES);
    writeFileSync(file, "{not json", { mode: 0o600 });
    expect(loadPreferences(env)).toEqual(DEFAULT_PREFERENCES);
    writeFileSync(file, JSON.stringify({ version: 1, unknown: "not persisted" }), { mode: 0o600 });
    expect(loadPreferences(env)).toEqual(DEFAULT_PREFERENCES);
  });

  test("rejects symlink destinations and preserves the symlink target", () => {
    const { root, env } = environment();
    const directory = join(root, "jira-desk");
    const target = join(root, "outside.json");
    mkdirSync(directory, { recursive: true });
    writeFileSync(target, "outside", { mode: 0o600 });
    symlinkSync(target, join(directory, "preferences.json"));
    expect(() => savePreferences({}, env)).toThrow(PreferencesError);
    expect(() => loadPreferences(env)).toThrow(PreferencesError);
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).size).toBe("outside".length);
  });

  test("atomically replaces the destination and leaves no temporary files", () => {
    const { root, env } = environment();
    savePreferences({ teamMembers: ["before"] }, env);
    const directory = join(root, "jira-desk");
    const before = readFileContents(pathFor(root));
    savePreferences({ teamMembers: ["after"], jqlScope: "project = DEV" }, env);
    const after = readFileContents(pathFor(root));
    expect(before).not.toBe(after);
    expect(loadPreferences(env).teamMembers).toEqual(["after"]);
    expect(readdirSync(directory).filter((name) => name.includes("preferences.json.")).length).toBe(0);
  });

  test("rejects invalid file modes on save only by restoring owner-only mode", () => {
    const { root, env } = environment();
    savePreferences({ theme: "System" }, env);
    chmodSync(pathFor(root), 0o644);
    savePreferences({ theme: "Dark" }, env);
    expect(statSync(pathFor(root)).mode & 0o777).toBe(0o600);
  });
});

function readFileContents(path: string): string {
  return readFileSync(path, "utf8");
}
