/**
 * The commands that complete what the input holds, shown in a list above it while the user types a
 * command.
 */

import type { KeyEvent } from "@opentui/core";
import { createMemo, createSignal } from "solid-js";

/** A command as the suggestion list shows it. */
export type CommandInfo = { readonly name: string; readonly description: string };

const COMMAND_START = /^\/[a-z-]*$/i;

/** The keys the list takes while it is open, before the input and the chat's own keys. */
const LIST_KEYS = new Set(["up", "down", "tab", "return", "escape"]);

/**
 * The commands that start with `text`, ignoring case. None when `text` is more than `/` and
 * letters, or is already a whole command, so that one Enter sends it.
 */
export const suggestions = (text: string, commands: readonly CommandInfo[]) => {
  if (!COMMAND_START.test(text) || commands.some((command) => command.name === text)) return [];
  const typed = text.toLowerCase();
  return commands.filter((command) => command.name.startsWith(typed));
};

export type CommandSuggestions = ReturnType<typeof commandSuggestions>;

/**
 * The list's state: the input's text, the chosen command, and whether Escape closed the list.
 * Escape closes it until the text changes.
 */
export const commandSuggestions = (commands: readonly CommandInfo[]) => {
  const [text, setText] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const [dismissed, setDismissed] = createSignal(false);
  const shown = createMemo(() => (dismissed() ? [] : suggestions(text(), commands)));
  const isOpen = () => shown().length > 0;

  const move = (step: number) => {
    const count = shown().length;
    setSelected((index) => (index + step + count) % count);
  };

  /** Up and Down move, Tab and Enter put the chosen command in the input, and Escape closes. */
  const takeKey = (key: KeyEvent, complete: (name: string) => void) => {
    const chosen = shown()[selected()];
    if (chosen === undefined || !LIST_KEYS.has(key.name)) return;
    key.preventDefault();

    if (key.name === "up") move(-1);
    else if (key.name === "down") move(1);
    else if (key.name === "escape") setDismissed(true);
    else complete(chosen.name);
  };

  return {
    shown,
    selected,
    isOpen,
    /** Whether the open list takes `key`, so that the chat's own keys leave it alone. */
    takes: (key: KeyEvent) => isOpen() && LIST_KEYS.has(key.name),
    takeKey,
    setText: (now: string) => {
      if (now === text()) return;
      setText(now);
      setSelected(0);
      setDismissed(false);
    },
  };
};
