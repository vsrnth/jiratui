import { describe, expect, test } from "bun:test";
import { editSecret, emptySecret, maskedSecret, backspaceSecret, moveSecret, pasteSecret, MAX_SECRET_BYTES } from "../src/secure-input";

describe("custom secret editor", () => {
  test("masks content and supports editing", () => {
    let editor = editSecret(emptySecret(), "abc");
    expect(maskedSecret(editor)).toBe("•••");
    editor = moveSecret(editor, -1);
    editor = backspaceSecret(editor);
    expect(editor.value).toBe("ac");
    expect(maskedSecret(editor)).not.toContain("a");
  });

  test("decodes paste and inserts at the secure editor cursor", () => {
    let editor = moveSecret(editSecret(emptySecret(), "abcd"), -2);
    editor = pasteSecret(editor, new TextEncoder().encode("XY"));
    expect(editor.value).toBe("abXYcd");
    expect(editor.cursor).toBe(4);
    expect(maskedSecret(editor)).not.toContain("XY");
  });

  test("rejects invalid UTF-8, controls, and whitespace", () => {
    const editor = editSecret(emptySecret(), "safe");
    for (const bytes of [
      new Uint8Array([0xc3, 0x28]),
      new TextEncoder().encode("line\nfeed"),
      new TextEncoder().encode("with space"),
      new TextEncoder().encode("control\u0000"),
    ]) {
      expect(pasteSecret(editor, bytes)).toEqual(editor);
    }
  });

  test("rejects an entire paste that exceeds the 4096-byte token bound", () => {
    const empty = emptySecret();
    expect(pasteSecret(empty, new TextEncoder().encode("a".repeat(MAX_SECRET_BYTES + 1)))).toEqual(empty);

    const nearLimit = editSecret(empty, "a".repeat(MAX_SECRET_BYTES - 1));
    const multibyte = pasteSecret(nearLimit, new TextEncoder().encode("€"));
    expect(multibyte).toEqual(nearLimit);

    const unicode = pasteSecret(empty, new TextEncoder().encode("€".repeat(MAX_SECRET_BYTES)));
    expect(unicode).toEqual(empty);
    expect(maskedSecret(unicode)).not.toContain("€");
  });
});
