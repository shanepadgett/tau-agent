/** The input editor, where the user writes prompts, steering messages and commands. */

// Enter sends, Tab queues during a run, and Shift-Enter, Ctrl-Enter, Alt-Enter or Ctrl-J add a
// line. While the command suggestion list is open, it takes Up, Down, Tab, Enter and Escape. Prompts that were cancelled or not sent come back into it, and its text survives a restart.

import type { KeyBinding, TextareaRenderable } from "@opentui/core";
import { createEffect, on } from "solid-js";
import type { ChatClient } from "./chat-client.ts";
import type { CommandSuggestions } from "./command-suggestions.ts";
import { COLORS } from "./theme.ts";

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

export function Input(props: {
  readonly client: ChatClient;
  readonly suggestions: CommandSuggestions;
}) {
  return (
    <box border borderColor={COLORS.accent}>
      <textarea
        ref={(editor: TextareaRenderable) => {
          connectEditor(editor, props.client, props.suggestions);
        }}
        // An open picker takes the keys; the text stays.
        focused={props.client.picker() === undefined && props.client.commit.step() === undefined}
        keyBindings={KEY_BINDINGS}
        minHeight={1}
        maxHeight={MAX_INPUT_LINES}
        placeholder="Type a prompt"
      />
    </box>
  );
}

const connectEditor = (
  editor: TextareaRenderable,
  client: ChatClient,
  suggestions: CommandSuggestions,
) => {
  editor.onContentChange = () => {
    suggestions.setText(editor.plainText);
  };

  editor.setText(client.draft);
  editor.gotoBufferEnd();
  client.readDraftWith(() => editor.plainText);

  // Clear first: a prompt the chat cannot send comes back into the editor during `send`.
  const sendWith = (send: (text: string) => void) => {
    const text = editor.plainText.trim();
    if (text === "") return;
    editor.clear();
    send(text);
  };

  editor.onSubmit = () => {
    sendWith(client.send);
  };

  const complete = (name: string) => {
    editor.setText(name);
    editor.gotoBufferEnd();
  };

  // During a run, Enter steers it and Tab queues a prompt for after it. Shift+Tab steps the thinking
  // level, which the chat changes only between runs.
  editor.onKeyDown = (key) => {
    suggestions.takeKey(key, complete);

    if (!key.defaultPrevented && key.name === "tab" && key.shift) {
      key.preventDefault();
      client.stepThinking();
      return;
    }

    if (key.defaultPrevented || key.name !== "tab" || client.chat.run === "idle") return;
    key.preventDefault();
    sendWith(client.queue);
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
