/**
 * The chat screen: the transcript, and under it the run panel, the status strip, the input editor
 * and its footer. The sidebar is on the right.
 */

import {
  type CliRenderer,
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  type SyntaxStyle,
} from "@opentui/core";
import { KeymapProvider, useBindings } from "@opentui/keymap/solid";
import { render, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/solid";
import { type Accessor, onCleanup, Show } from "solid-js";
import { Chat } from "./Chat.tsx";
import type { ChatClient } from "./chat-client.ts";
import { addCodeLanguages } from "./code-languages.ts";
import { CommandList } from "./CommandList.tsx";
import { type CommandSuggestions, commandSuggestions } from "./command-suggestions.ts";
import { FileList } from "./FileList.tsx";
import { type FileSuggestions, fileSuggestions } from "./file-suggestions.ts";
import { Input } from "./Input.tsx";
import { InputFooter } from "./InputFooter.tsx";
import { PRIORITY, tauKeymap } from "./keymap.ts";
import { Picker } from "./Picker.tsx";
import { CommitPanel } from "./CommitPanel.tsx";
import { Place } from "./Place.tsx";
import { QnaPanel } from "./QnaPanel.tsx";
import { RunPanel } from "./RunPanel.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { SIDEBAR_COLUMNS, type SidebarState, sidebarState } from "./sidebar-state.ts";
import { StatusStrip } from "./StatusStrip.tsx";
import type { InputSuggestions } from "./suggestion-list.ts";
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
  const commands = commandSuggestions(props.client.commands);
  const files = fileSuggestions(props.client);
  const suggestions = inputSuggestions(commands, files);

  // A widget the user answers replaces the composer (the input editor; the status line under it stays) while open.
  const panelOpen = () =>
    props.client.picker() !== undefined ||
    props.client.commit.step() !== undefined ||
    props.client.qna.state() !== undefined;

  const terminal = useTerminalDimensions();
  const sidebar = sidebarState(() => terminal().width, props.client.sidebar);
  chatKeys(props.client, panelOpen, sidebar);

  // The columns of the chat: the terminal less its padding and a docked open sidebar.
  const docked = () => sidebar.mode() === "docked" && sidebar.isOpen();
  const chatColumns = () => terminal().width - 2 - (docked() ? SIDEBAR_COLUMNS : 0);

  return (
    <Place name="app">
      <box flexDirection="row" width="100%" height="100%">
        <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
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
              <Show when={props.client.qna.state()} keyed>
                {(state) => <QnaPanel flow={props.client.qna} state={state} />}
              </Show>
              <Show when={!files.isOpen()}>
                <CommandList suggestions={commands} />
              </Show>
              <FileList suggestions={files} columns={chatColumns} />
            </Place>
            {/* Hidden, not removed, so the draft stays in the editor. */}
            <box flexDirection="column" visible={!panelOpen()}>
              <Place name="input.editor">
                <Input client={props.client} suggestions={suggestions} syntax={props.syntax} />
              </Place>
            </box>
            <Place name="input.below">
              <InputFooter client={props.client} suggestions={suggestions} columns={chatColumns} />
            </Place>
          </box>
        </box>
        <Sidebar sidebar={sidebar} chat={props.client.chat} />
      </box>
    </Place>
  );
}

/** Both lists follow the input. A tag can sit in a command's arguments; the file list then takes the keys. */
const inputSuggestions = (
  commands: CommandSuggestions,
  files: FileSuggestions,
): InputSuggestions => ({
  setInput: (text, cursor) => {
    commands.setText(text);
    files.setInput(text, cursor);
  },
  open: () => {
    if (files.isOpen()) return files;
    return commands.isOpen() ? commands : undefined;
  },
});

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
 * Escape cancels a run. Ctrl-C cancels a run, or quits when none is going. Ctrl-D quits. Ctrl-B
 * shows or hides the sidebar. The keys of an open picker or commit panel, an open sidebar drawer,
 * the command list and the input come first.
 */
const chatKeys = (client: ChatClient, panelOpen: () => boolean, sidebar: SidebarState) => {
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
      { name: "sidebar.toggle", run: sidebar.toggle },
    ],
    bindings: [
      { key: "escape", cmd: "run.cancel" },
      { key: "ctrl+c", cmd: "chat.interrupt" },
      { key: "ctrl+d", cmd: "chat.quit" },
      // Before the text area's own Ctrl-B, which moves the cursor left like the Left key.
      { key: "ctrl+b", cmd: "sidebar.toggle" },
    ],
  }));
};
