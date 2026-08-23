/** A small editor whose rendering surface exposes only masked token text. */
export type SecretEditor = { value: string; cursor: number };
export const MAX_SECRET_BYTES = 4_096;

const utf8 = new TextEncoder();
const utf8Length = (value: string): number => utf8.encode(value).byteLength;

export function emptySecret(): SecretEditor { return { value: "", cursor: 0 }; }
export function editSecret(editor: SecretEditor, input: string): SecretEditor {
  const safe = [...input].filter((char) => char >= " " && char !== "\u007f").join("");
  const value = editor.value.slice(0, editor.cursor) + safe + editor.value.slice(editor.cursor);
  return { value, cursor: editor.cursor + safe.length };
}

/** Decode and insert terminal bracketed-paste bytes without accepting token-invalid input. */
export function pasteSecret(editor: SecretEditor, bytes: Uint8Array): SecretEditor {
  let pasted: string;
  try { pasted = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return editor; }
  if (!pasted || [...pasted].some((char) => /\p{Cc}/u.test(char) || /\s/u.test(char))) return editor;
  const prefix = editor.value.slice(0, editor.cursor);
  const suffix = editor.value.slice(editor.cursor);
  if (utf8Length(prefix) + utf8Length(pasted) + utf8Length(suffix) > MAX_SECRET_BYTES) return editor;
  return { value: prefix + pasted + suffix, cursor: editor.cursor + pasted.length };
}

export function backspaceSecret(editor: SecretEditor): SecretEditor {
  if (editor.cursor === 0) return editor;
  return { value: editor.value.slice(0, editor.cursor - 1) + editor.value.slice(editor.cursor), cursor: editor.cursor - 1 };
}
export function deleteSecret(editor: SecretEditor): SecretEditor {
  if (editor.cursor >= editor.value.length) return editor;
  return { value: editor.value.slice(0, editor.cursor) + editor.value.slice(editor.cursor + 1), cursor: editor.cursor };
}
export function moveSecret(editor: SecretEditor, delta: number): SecretEditor {
  return { ...editor, cursor: Math.max(0, Math.min(editor.value.length, editor.cursor + delta)) };
}
export function maskedSecret(editor: SecretEditor): string {
  return "•".repeat(editor.value.length);
}
