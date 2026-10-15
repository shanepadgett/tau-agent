/** The input editor, where the user writes prompts, steering messages and commands. */

// Enter sends, Tab queues during a run, and Shift-Enter, Ctrl-Enter, Alt-Enter or Ctrl-J add a
// line (see `keymap.ts`). While the command list or the `@` file list is open, it takes Up, Down,
// Tab, Enter, Escape and Ctrl-C. Tags show in the accent color. Prompts that were cancelled or not sent come back into it, and its text survives
// a restart.

import type { PasteEvent, SyntaxStyle, TextareaRenderable } from "@opentui/core";
import { Option } from "effect";
import { useBindings } from "@opentui/keymap/solid";
import { createEffect, on, Show } from "solid-js";
import type { ChatClient } from "./chat-client.ts";
import { enterBindings, PRIORITY } from "./keymap.ts";
import type { Completion, InputSuggestions } from "./suggestion-list.ts";
import { tagRanges } from "../../core/TagText.ts";
import { COLORS, TAG_STYLE } from "./theme.ts";
import { createPictures, droppedImagePath } from "./pictures.ts";
import { isImagePath } from "../../core/ImagePath.ts";

const MAX_INPUT_LINES = 10;

export function Input(props: {
  readonly client: ChatClient;
  readonly suggestions: InputSuggestions;
  readonly syntax: SyntaxStyle;
}) {
  const pictures = createPictures();

  return (
    <box>
      <box border borderColor={COLORS.accent}>
        <textarea
          ref={(editor: TextareaRenderable) => {
            editor.syntaxStyle = props.syntax;
            connectEditor(editor, props.client, props.suggestions, pictures);
          }}
          // An open picker takes the keys; the text stays.
          focused={
            props.client.picker() === undefined &&
            props.client.commit.step() === undefined &&
            props.client.qna.state() === undefined
          }
          minHeight={1}
          maxHeight={MAX_INPUT_LINES}
          placeholder="Type a prompt"
        />
      </box>
      <Show when={!props.client.sees() && pictures.named().length > 0}>
        <text fg={COLORS.warning}>
          this model cannot see images; {pictures.named().join(", ")} will be left out
        </text>
      </Show>
    </box>
  );
}

type Pictures = ReturnType<typeof createPictures>;

/** Puts a picture's chip at the cursor. */
const insertPicture = (editor: TextareaRenderable, pictures: Pictures, bytes: Uint8Array) => {
  editor.insertText(pictures.add(bytes));
};

/**
 * An empty paste means the terminal had a picture to paste, so the clipboard is read. A pasted path
 * of a picture file becomes a chip; any other paste goes in as text.
 */
const pasteKeys = (editor: TextareaRenderable, client: ChatClient, pictures: Pictures) => {
  editor.onPaste = (event: PasteEvent) => {
    const text = new TextDecoder().decode(event.bytes);

    if (text === "") {
      event.preventDefault();
      pasteClipboardPicture(editor, client, pictures);
      return;
    }

    const path = droppedImagePath(text);
    if (Option.isNone(path)) return;
    event.preventDefault();

    void client.readPicture(path.value).then((bytes) => {
      if (bytes === undefined) editor.insertText(text);
      else insertPicture(editor, pictures, bytes);
    });
  };
};

const pasteClipboardPicture = (
  editor: TextareaRenderable,
  client: ChatClient,
  pictures: Pictures,
) => {
  void client.clipboardPicture().then((bytes) => {
    if (bytes !== undefined) insertPicture(editor, pictures, bytes);
  });
};

const connectEditor = (
  editor: TextareaRenderable,
  client: ChatClient,
  suggestions: InputSuggestions,
  pictures: Pictures,
) => {
  const follow = () => {
    suggestions.setInput(editor.plainText, editor.cursorOffset);
    client.trackDraft(editor.plainText);
    pictures.follow(editor.plainText);
  };

  editor.onContentChange = () => {
    follow();
    colorTags(editor);
  };

  editor.onCursorChange = follow;

  editor.setText(client.draft);
  editor.gotoBufferEnd();
  client.trackDraft(editor.plainText);

  client.attachEditor({
    read: () => editor.plainText,
    write: (text) => {
      replaceText(editor, text);
    },
  });

  editor.onSubmit = () => {
    sendWith(editor, client.send, pictures);
  };

  pasteKeys(editor, client, pictures);
  listKeys(editor, { client, suggestions, pictures });
  inputKeys(editor, client, pictures);

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

type ListParts = {
  readonly client: ChatClient;
  readonly suggestions: InputSuggestions;
  readonly pictures: Pictures;
};

/** Up and Down move in the open list, Escape and Ctrl-C close it, Tab and Enter complete. */
const listKeys = (editor: TextareaRenderable, { client, suggestions, pictures }: ListParts) => {
  const apply = (completion: Completion | undefined) => {
    if (completion === undefined) return false;

    if (completion.type === "replace") {
      const text = editor.plainText;

      editor.setText(
        text.slice(0, completion.start) + completion.text + text.slice(completion.end),
      );

      editor.cursorOffset = completion.start + completion.text.length;
      pictureFromTag(editor, client, pictures, completion);
      return;
    }

    replaceText(editor, completion.name);
    sendWith(editor, client.send, pictures);
  };

  useBindings(() => ({
    target: () => editor,
    targetMode: "focus",
    priority: PRIORITY.list,
    enabled: () => suggestions.open() !== undefined,
    commands: [
      {
        name: "list.up",
        run: () => {
          suggestions.open()?.move(-1);
        },
      },
      {
        name: "list.down",
        run: () => {
          suggestions.open()?.move(1);
        },
      },
      {
        name: "list.close",
        run: () => {
          suggestions.open()?.dismiss();
        },
      },
      { name: "list.complete", run: () => apply(suggestions.open()?.completionFor("tab")) },
      { name: "list.choose", run: () => apply(suggestions.open()?.completionFor("return")) },
    ],
    bindings: [
      { key: "up", cmd: "list.up" },
      { key: "down", cmd: "list.down" },
      { key: "escape", cmd: "list.close" },
      { key: "ctrl+c", cmd: "list.close" },
      { key: "tab", cmd: "list.complete" },
      ...enterBindings("list.choose"),
    ],
  }));
};

/**
 * Ctrl-S stashes the text. During a run, Tab queues a prompt for after it. Shift+Tab steps the thinking level, which the chat
 * changes only between runs. Ctrl-C clears the input, and goes on to the chat when it is empty.
 */
const inputKeys = (editor: TextareaRenderable, client: ChatClient, pictures: Pictures) => {
  useBindings(() => ({
    target: () => editor,
    targetMode: "focus",
    priority: PRIORITY.input,
    commands: [
      {
        name: "prompt.queue",
        run: () => {
          if (client.chat.run === "idle") return false;
          sendWith(editor, client.queue, pictures);
        },
      },
      { name: "thinking.next", run: client.stepThinking },
      {
        name: "picture.paste",
        run: () => {
          pasteClipboardPicture(editor, client, pictures);
        },
      },
      {
        name: "prompt.stash",
        run: () => {
          if (editor.plainText.trim() === "") return false;
          client.stash();
        },
      },
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
      { key: "ctrl+s", cmd: "prompt.stash" },
      { key: "ctrl+v", cmd: "picture.paste" },
      { key: "super+v", cmd: "picture.paste" },
    ],
  }));
};

// Clear first: a prompt the chat cannot send comes back into the editor during `send`.
const sendWith = (
  editor: TextareaRenderable,
  send: (text: string, images: readonly Uint8Array[]) => void,
  pictures: Pictures,
) => {
  const typed = editor.plainText.trim();
  if (typed === "") return;
  editor.clear();
  const { text, images } = pictures.take(typed);
  send(text, images);
};

/**
 * A tagged picture file turns into a chip once its bytes are read, if the tag is still where the
 * list put it. A file that cannot be read stays a tag.
 */
const pictureFromTag = (
  editor: TextareaRenderable,
  client: ChatClient,
  pictures: Pictures,
  completion: { readonly start: number; readonly text: string },
) => {
  const tag = completion.text.trim();
  const path = tag.replace(/^@"?|"$/g, "");
  if (!tag.startsWith("@") || !isImagePath(path)) return;

  void client.readPicture(path).then((bytes) => {
    const text = editor.plainText;
    const end = completion.start + tag.length;
    if (bytes === undefined || text.slice(completion.start, end) !== tag) return;

    const chip = pictures.add(bytes);
    editor.setText(text.slice(0, completion.start) + chip + text.slice(end));
    editor.cursorOffset = completion.start + chip.length;
  });
};

const replaceText = (editor: TextareaRenderable, text: string) => {
  editor.setText(text);
  editor.gotoBufferEnd();
};

/**
 * Colors each tag. Highlight offsets skip the newlines that the text's offsets count, and they match
 * the text's offsets only while no character wider than one column comes before a tag.
 */
const colorTags = (editor: TextareaRenderable) => {
  const styleId = editor.syntaxStyle?.getStyleId(TAG_STYLE);
  if (styleId === undefined || styleId === null) return;
  const text = editor.plainText;
  editor.clearAllHighlights();

  for (const [start, end] of tagRanges(text)) {
    const newlines = text.slice(0, start).split("\n").length - 1;
    editor.addHighlightByCharRange({ start: start - newlines, end: end - newlines, styleId });
  }
};
