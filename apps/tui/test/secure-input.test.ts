import { describe, expect, test } from "bun:test";
import { editSecret, emptySecret, maskedSecret, backspaceSecret, moveSecret } from "../src/secure-input";

describe("custom secret editor", () => {
  test("masks content and supports editing", () => {
    let editor = editSecret(emptySecret(), "abc");
    expect(maskedSecret(editor)).toBe("•••");
    editor = moveSecret(editor, -1);
    editor = backspaceSecret(editor);
    expect(editor.value).toBe("ac");
    expect(maskedSecret(editor)).not.toContain("a");
  });
});
