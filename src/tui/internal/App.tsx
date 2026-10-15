/**
 * The chat screen: the transcript, and under it the run panel, the status strip, the input editor
 * and its footer.
 */

import {
  type CliRenderer,
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  type SyntaxStyle,
} from "@opentui/core";
import { KeymapProvider, useBindings } from "@opentui/keymap/solid";
import { render, useRenderer, useSelectionHandler } from "@opentui/solid";
import { type Accessor, onCleanup, Show } from "solid-js";
import { Chat } from "./Chat.tsx";
import type { ChatClient } from "./chat-client.ts";
import { addCodeLanguages } from "./code-languages.ts";
import { CommandList } from "./CommandList.tsx";
import { commandSuggestions } from "./command-suggestions.ts";
import { Input } from "./Input.tsx";
import { InputFooter } from "./InputFooter.tsx";
import { PRIORITY, tauKeymap } from "./keymap.ts";
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
  const keymap = tauKeymap(renderer);

  return render(
    () => (
      <KeymapProvider keymap={keymap}>
        <Screen client={client} />
      </KeymapProvider>
    ),
    renderer,
  );
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

  // A widget the user answers replaces the composer (the input editor; the status line under it stays) while open.
  const panelOpen = () =>
    props.client.picker() !== undefined || props.client.commit.step() !== undefined;

  chatKeys(props.client, panelOpen);

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
          {/* Hidden, not removed, so the draft stays in the editor. */}
          <box flexDirection="column" visible={!panelOpen()}>
            <Place name="input.editor">
              <Input client={props.client} suggestions={suggestions} />
            </Place>
          </box>
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

/**
 * Escape cancels a run. Ctrl-C cancels a run, or quits when none is going. Ctrl-D quits. The keys of
 * an open picker or commit panel, the command list and the input come first.
 */
const chatKeys = (client: ChatClient, panelOpen: () => boolean) => {
  const isRunning = () => client.chat.run !== "idle";

  useBindings(() => ({
    priority: PRIORITY.chat,
    // An open panel leaves only its own keys working, so Ctrl-D does not quit from it.
    enabled: () => !panelOpen(),
    commands: [
      {
        name: "run.cancel",
        run: () => {
          if (!isRunning()) return false;
          client.cancel();
        },
      },
      {
        name: "chat.interrupt",
        run: () => {
          if (isRunning()) client.cancel();
          else client.quit();
        },
      },
      { name: "chat.quit", run: client.quit },
    ],
    bindings: [
      { key: "escape", cmd: "run.cancel" },
      { key: "ctrl+c", cmd: "chat.interrupt" },
      { key: "ctrl+d", cmd: "chat.quit" },
    ],
  }));
};
