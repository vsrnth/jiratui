/** A small masked editor. The actual token never belongs in rendered state. */
export type SecretEditor = { value: string; cursor: number };

export function emptySecret(): SecretEditor { return { value: "", cursor: 0 }; }
export function editSecret(editor: SecretEditor, input: string): SecretEditor {
  const safe = [...input].filter((char) => char >= " " && char !== "\u007f").join("");
  const value = editor.value.slice(0, editor.cursor) + safe + editor.value.slice(editor.cursor);
  return { value, cursor: editor.cursor + safe.length };
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
