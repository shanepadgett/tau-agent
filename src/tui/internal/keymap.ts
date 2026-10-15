/**
 * Tau's key map: it turns key presses into named commands. Each part of the chat registers a layer of
 * bindings while it shows, and the layer priorities below decide which part gets a key first.
 */

import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import type { Binding, Keymap } from "@opentui/keymap";
import { registerManagedTextareaLayer } from "@opentui/keymap/addons/opentui";
import { formatKeySequence } from "@opentui/keymap/extras";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";

export type TauKeymap = Keymap<Renderable, KeyEvent>;

/**
 * A panel the user answers comes first, then an open sidebar drawer, then the command list, then the
 * input's own keys, then the chat's. The editing keys of OpenTUI's text areas have priority 0, so Ctrl-D quits instead of
 * deleting a character.
 */
export const PRIORITY = { panel: 30, drawer: 25, list: 20, input: 10, chat: 5 } as const;

// OpenTUI's defaults add a line on Enter and send on Alt-Enter. These come first, so they win.
// Shift-Enter and Ctrl-Enter reach Tau only with the kitty keyboard protocol; Ctrl-J works in every
// terminal, where it arrives as `linefeed`, which adds a line by default. The first newline key is
// the one the footer shows.
export const enterBindings = (command: string): readonly Binding<Renderable, KeyEvent>[] => [
  { key: "return", cmd: command },
  { key: "kpenter", cmd: command },
];

const EDITOR_BINDINGS: readonly Binding<Renderable, KeyEvent>[] = [
  ...enterBindings("input.submit"),
  { key: "shift+return", cmd: "input.newline" },
  { key: "ctrl+return", cmd: "input.newline" },
  { key: "meta+return", cmd: "input.newline" },
  { key: "ctrl+j", cmd: "input.newline" },
];

/** The names the footer shows for keys, as people read them on a keyboard. */
const KEY_NAMES = { return: "enter", escape: "esc", up: "↑", down: "↓" };

/**
 * A key map for `renderer`, with the editing keys of the text area in focus. It lives as long as the
 * renderer, which removes its key listeners when it is destroyed.
 */
export const tauKeymap = (renderer: CliRenderer): TauKeymap => {
  const keymap = createDefaultOpenTuiKeymap(renderer);
  registerManagedTextareaLayer(keymap, renderer, { bindings: [...EDITOR_BINDINGS] });
  return keymap;
};

/** The first key bound to `command`, such as `shift+enter`, or nothing when none is bound. */
export const keyText = (keymap: TauKeymap, command: string) => {
  const bindings = keymap.getCommandBindings({ commands: [command], visibility: "registered" });
  const [first] = bindings.get(command) ?? [];

  return first === undefined
    ? ""
    : formatKeySequence(first.sequence, { keyNameAliases: KEY_NAMES });
};
