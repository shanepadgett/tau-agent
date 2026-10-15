/** The input editor, where the user writes prompts, steering messages and commands. */

// Enter sends, Tab queues during a run, and Shift-Enter, Ctrl-Enter, Alt-Enter or Ctrl-J add a
// line (see `keymap.ts`). While the command suggestion list is open, it takes Up, Down, Tab, Enter,
// Escape and Ctrl-C. Prompts that were cancelled or not sent come back into it, and its text survives
// a restart.

import type { TextareaRenderable } from "@opentui/core";
import { useBindings } from "@opentui/keymap/solid";
import { createEffect, on } from "solid-js";
import type { ChatClient } from "./chat-client.ts";
import type { CommandSuggestions, Completion } from "./command-suggestions.ts";
import { PRIORITY } from "./keymap.ts";
import { COLORS } from "./theme.ts";

const MAX_INPUT_LINES = 10;

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

  editor.onSubmit = () => {
    sendWith(editor, client.send);
  };

  listKeys(editor, client, suggestions);
  inputKeys(editor, client);

  createEffect(
    on(
      () => client.chat.returned?.id,
      () => {
        const returned = client.chat.returned;
        if (returned === undefined) return;
        const draft = [...returned.prompts, editor.plainText].filter((text) => text !== "");
        replaceText(editor, draft.join("\n\n"));
      },
      { defer: true },
    ),
  );
};

/** Up and Down move in the open command list, Escape and Ctrl-C close it, Tab and Enter complete. */
const listKeys = (
  editor: TextareaRenderable,
  client: ChatClient,
  suggestions: CommandSuggestions,
) => {
  const apply = (completion: Completion | undefined) => {
    if (completion === undefined) return false;

    if (completion.type === "complete") {
      replaceText(editor, completion.text);
      return;
    }

    replaceText(editor, completion.name);
    sendWith(editor, client.send);
  };

  useBindings(() => ({
    target: () => editor,
    targetMode: "focus",
    priority: PRIORITY.list,
    enabled: suggestions.isOpen,
    commands: [
      {
        name: "list.up",
        run: () => {
          suggestions.move(-1);
        },
      },
      {
        name: "list.down",
        run: () => {
          suggestions.move(1);
        },
      },
      { name: "list.close", run: suggestions.dismiss },
      { name: "list.complete", run: () => apply(suggestions.completionFor("tab")) },
      { name: "list.choose", run: () => apply(suggestions.completionFor("return")) },
    ],
    bindings: [
      { key: "up", cmd: "list.up" },
      { key: "down", cmd: "list.down" },
      { key: "escape", cmd: "list.close" },
      { key: "ctrl+c", cmd: "list.close" },
      { key: "tab", cmd: "list.complete" },
      { key: "return", cmd: "list.choose" },
    ],
  }));
};

/**
 * During a run, Tab queues a prompt for after it. Shift+Tab steps the thinking level, which the chat
 * changes only between runs. Ctrl-C clears the input, and goes on to the chat when it is empty.
 */
const inputKeys = (editor: TextareaRenderable, client: ChatClient) => {
  useBindings(() => ({
    target: () => editor,
    targetMode: "focus",
    priority: PRIORITY.input,
    commands: [
      {
        name: "prompt.queue",
        run: () => {
          if (client.chat.run === "idle") return false;
          sendWith(editor, client.queue);
        },
      },
      { name: "thinking.next", run: client.stepThinking },
      {
        name: "input.clear",
        run: () => {
          if (editor.plainText === "") return false;
          editor.clear();
        },
      },
    ],
    bindings: [
      { key: "tab", cmd: "prompt.queue" },
      { key: "shift+tab", cmd: "thinking.next" },
      { key: "ctrl+c", cmd: "input.clear" },
    ],
  }));
};

// Clear first: a prompt the chat cannot send comes back into the editor during `send`.
const sendWith = (editor: TextareaRenderable, send: (text: string) => void) => {
  const text = editor.plainText.trim();
  if (text === "") return;
  editor.clear();
  send(text);
};

const replaceText = (editor: TextareaRenderable, text: string) => {
  editor.setText(text);
  editor.gotoBufferEnd();
};
