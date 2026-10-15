/**
 * The chat screen: the transcript, and under it the run panel, the status strip, the input editor
 * and its footer.
 */

import {
  type CliRenderer,
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  type KeyEvent,
  type SyntaxStyle,
} from "@opentui/core";
import { render, useKeyboard, useRenderer, useSelectionHandler } from "@opentui/solid";
import { type Accessor, onCleanup, Show } from "solid-js";
import { Chat } from "./Chat.tsx";
import type { ChatClient } from "./chat-client.ts";
import { addCodeLanguages } from "./code-languages.ts";
import type { ChatState } from "./chat-state.ts";
import { CommandList } from "./CommandList.tsx";
import { commandSuggestions } from "./command-suggestions.ts";
import { Input } from "./Input.tsx";
import { InputFooter } from "./InputFooter.tsx";
import { Picker } from "./Picker.tsx";
import { CommitPanel } from "./CommitPanel.tsx";
import { Place } from "./Place.tsx";
import { RunPanel } from "./RunPanel.tsx";
import { StatusStrip } from "./StatusStrip.tsx";
import { useSyntaxStyle } from "./theme.ts";

/**
 * Draws the chat of the current client on `renderer`. It stays until the renderer is destroyed. A
 * new client, for another session, draws a new chat.
 */
export const showChat = (renderer: CliRenderer, client: Accessor<ChatClient | undefined>) => {
  addCodeLanguages();
  return render(() => <Screen client={client} />, renderer);
};

function Screen(props: { readonly client: Accessor<ChatClient | undefined> }) {
  copySelections();
  const syntax = useSyntaxStyle();

  return (
    <Show when={props.client()} keyed>
      {(client) => <App client={client} syntax={syntax} />}
    </Show>
  );
}

function App(props: { readonly client: ChatClient; readonly syntax: SyntaxStyle }) {
  const suggestions = commandSuggestions(props.client.commands);

  useKeyboard((key) => {
    // The open picker or commit panel takes the keys, and the open suggestion list its own keys, such as Escape.
    const panelOpen =
      props.client.picker() !== undefined || props.client.commit.step() !== undefined;

    if (panelOpen || suggestions.takes(key)) return;
    const action = keyAction(key, props.client.chat);
    if (action === undefined) return;
    key.preventDefault();
    props.client[action]();
  });

  return (
    <Place name="app">
      <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
        <Place name="chat">
          <Chat chat={props.client.chat} syntax={props.syntax} />
        </Place>
        {/* The input keeps its height; the transcript shrinks and scrolls instead. */}
        <box flexDirection="column" flexShrink={0}>
          <Place name="input.above">
            <RunPanel chat={props.client.chat} />
            <StatusStrip client={props.client} />
            <Show when={props.client.picker()} keyed>
              {(picker) => <Picker picker={picker} close={props.client.closePicker} />}
            </Show>
            <Show when={props.client.commit.step()} keyed>
              {(step) => <CommitPanel flow={props.client.commit} step={step} />}
            </Show>
            <CommandList suggestions={suggestions} />
          </Place>
          <Place name="input.editor">
            <Input client={props.client} suggestions={suggestions} />
          </Place>
          <Place name="input.below">
            <InputFooter client={props.client} suggestions={suggestions} />
          </Place>
        </box>
      </box>
    </Place>
  );
}

/**
 * Copies text when the user lets go of the mouse after selecting it: to the system clipboard, or
 * through the terminal (OSC 52) when the system clipboard cannot be reached, as over SSH.
 */
const copySelections = () => {
  const renderer = useRenderer();
  const host = createHostClipboard();
  const clipboard = createClipboard({ host, terminal: createRendererClipboardAdapter(renderer) });
  onCleanup(() => void clipboard.dispose());

  useSelectionHandler((selection) => {
    const text = selection.getSelectedText();
    if (text !== "") void clipboard.writeText(text, { destination: "best-available" });
  });
};

/** Escape cancels a run. Ctrl-C cancels a run, or quits when none is going. Ctrl-D quits. */
const keyAction = (key: KeyEvent, chat: ChatState): "cancel" | "quit" | undefined => {
  const isRunning = chat.run !== "idle";
  if (key.name === "escape" && isRunning) return "cancel";
  if (key.ctrl && key.name === "c") return isRunning ? "cancel" : "quit";
  if (key.ctrl && key.name === "d") return "quit";
  return undefined;
};
