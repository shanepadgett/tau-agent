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
} from "@opentui/core";
import { render, useKeyboard, useRenderer, useSelectionHandler } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { Chat } from "./Chat.tsx";
import type { ChatClient } from "./chat-client.ts";
import type { ChatState } from "./chat-state.ts";
import { Input } from "./Input.tsx";
import { InputFooter } from "./InputFooter.tsx";
import { Place } from "./Place.tsx";
import { RunPanel } from "./RunPanel.tsx";
import { StatusStrip } from "./StatusStrip.tsx";

/** Draws the chat on `renderer`. It stays until the renderer is destroyed. */
export const showChat = (renderer: CliRenderer, client: ChatClient) =>
  render(() => <App client={client} />, renderer);

function App(props: { readonly client: ChatClient }) {
  copySelections();

  useKeyboard((key) => {
    const action = keyAction(key, props.client.chat);
    if (action === undefined) return;
    key.preventDefault();
    props.client[action]();
  });

  return (
    <Place name="app">
      <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
        <Place name="chat">
          <Chat chat={props.client.chat} />
        </Place>
        {/* The input keeps its height; the transcript shrinks and scrolls instead. */}
        <box flexDirection="column" flexShrink={0}>
          <Place name="input.above">
            <RunPanel chat={props.client.chat} />
            <StatusStrip client={props.client} />
          </Place>
          <Place name="input.editor">
            <Input client={props.client} />
          </Place>
          <Place name="input.below">
            <InputFooter client={props.client} />
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
