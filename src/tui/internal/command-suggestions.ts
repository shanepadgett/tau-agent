/**
 * The commands that complete what the input holds, shown in a list above it while the user types a
 * command.
 */

import type { KeyEvent } from "@opentui/core";
import { createMemo, createSignal } from "solid-js";

/** A command as the suggestion list shows it. */
export type CommandInfo = {
  readonly name: string;
  readonly description: string;
  /** Whether text after the name is an argument the command may take or must take. */
  readonly argument: "none" | "optional" | "required";
};

/** A slash and the command's letters, then the end or a space, after which come its arguments. */
const COMMAND_START = /^\/[a-z-]*(\s|$)/i;

/** The keys the list takes while it is open, before the input and the chat's own keys. */
const LIST_KEYS = new Set(["up", "down", "tab", "return", "escape"]);

/** The command word of `text`, lower case: the slash and letters before the first space. */
const wordOf = (text: string) => (text.split(/\s/, 1)[0] ?? "").toLowerCase();

/**
 * The commands that start with the command word of `text`, ignoring case, the whole one first. Once
 * a space follows the word, only the command it names. None when `text` is not a command.
 */
export const suggestions = (text: string, commands: readonly CommandInfo[]) => {
  if (!COMMAND_START.test(text)) return [];
  const word = wordOf(text);
  const exact = commands.filter((command) => command.name === word);
  if (word !== text.toLowerCase() && /\s/.test(text)) return exact;

  return [
    ...exact,
    ...commands.filter((command) => command.name !== word && command.name.startsWith(word)),
  ];
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
  /** Whether the input already holds the chosen command whole, so there is nothing to complete. */
  const isWhole = () => wordOf(text()) === shown()[selected()]?.name;
  const hasSpace = () => /\s/.test(text());

  const move = (step: number) => {
    const count = shown().length;
    setSelected((index) => (index + step + count) % count);
  };

  /**
   * Up and Down move, and Escape closes. Tab puts the chosen command in the input, with a space
   * after it when it takes an argument. Enter does the same for a command that requires an argument,
   * and runs any other command.
   */
  const takeKey = (
    key: KeyEvent,
    complete: (text: string) => void,
    run: (text: string) => void,
  ) => {
    const chosen = shown()[selected()];
    if (chosen === undefined || !LIST_KEYS.has(key.name)) return;
    const isEnter = key.name === "return";
    const isCompletion = isEnter || key.name === "tab";
    // A command typed whole, with a space after it, is complete: Enter sends it with its arguments.
    if (isCompletion && isWhole() && hasSpace()) return;
    // Tab leaves a whole command that takes no argument to the chat's own Tab.
    if (key.name === "tab" && isWhole() && chosen.argument === "none") return;
    key.preventDefault();

    if (key.name === "up") move(-1);
    else if (key.name === "down") move(1);
    else if (key.name === "escape") setDismissed(true);
    else if (isEnter && chosen.argument !== "required") run(chosen.name);
    else complete(chosen.argument === "none" ? chosen.name : `${chosen.name} `);
  };

  return {
    shown,
    selected,
    isOpen,
    /** Whether Tab and Enter would complete the chosen command. */
    completes: () => isOpen() && !(isWhole() && hasSpace()),
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
