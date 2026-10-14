/**
 * The input editor: Enter sends, and Shift-Enter, Ctrl-Enter, Alt-Enter or Ctrl-J add a line.
 * Prompts that were cancelled or not sent come back into it.
 */

import type { KeyBinding, TextareaRenderable } from "@opentui/core";
import { createEffect, on } from "solid-js";
import type { ChatClient } from "./chat-client.ts";

const MAX_INPUT_LINES = 10;

// OpenTUI's defaults add a line on Enter and send on Alt-Enter. These win over them. Shift-Enter
// and Ctrl-Enter reach Tau only with the kitty keyboard protocol; Ctrl-J works in every terminal,
// where it arrives as `linefeed`, which adds a line by default.
const KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
];

export function Input(props: { readonly client: ChatClient }) {
  return (
    <box border borderColor="#61afef">
      <textarea
        ref={(editor: TextareaRenderable) => {
          connectEditor(editor, props.client);
        }}
        focused
        keyBindings={KEY_BINDINGS}
        minHeight={1}
        maxHeight={MAX_INPUT_LINES}
        placeholder="Type a prompt"
      />
    </box>
  );
}

const connectEditor = (editor: TextareaRenderable, client: ChatClient) => {
  editor.onSubmit = () => {
    const text = editor.plainText.trim();
    if (text === "") return;
    // Clear first: a prompt the chat cannot send comes back into the editor during `send`.
    editor.clear();
    client.send(text);
  };

  createEffect(
    on(
      () => client.chat.returned?.id,
      () => {
        const returned = client.chat.returned;
        if (returned === undefined) return;
        const draft = [...returned.prompts, editor.plainText].filter((text) => text !== "");
        editor.setText(draft.join("\n\n"));
        editor.gotoBufferEnd();
      },
      { defer: true },
    ),
  );
};
