/**
 * The commands that complete what the input holds, shown in a list above it while the user types a
 * command.
 */

import { createMemo, createSignal } from "solid-js";
import { type Completion, type SuggestionKeys, suggestionList } from "./suggestion-list.ts";

/** A command as the suggestion list shows it. */
export type CommandInfo = {
  readonly name: string;
  readonly description: string;
  /** Whether text after the name is an argument the command may take or must take. */
  readonly argument: "none" | "optional" | "required";
};

/** A slash and the command's letters, then the end or a space, after which come its arguments. */
const COMMAND_START = /^\/[a-z-]*(\s|$)/i;

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
  const matching = createMemo(() => suggestions(text(), commands));
  const list = suggestionList(matching);
  const shown = () => (list.dismissed() ? [] : matching());
  const isOpen = () => shown().length > 0;
  /** Whether the input already holds the chosen command whole, so there is nothing to complete. */
  const isWhole = () => wordOf(text()) === list.chosen()?.name;
  const hasSpace = () => /\s/.test(text());

  /**
   * Tab puts the chosen command in the input, with a space after it when it takes an argument. Enter
   * does the same for a command that requires an argument, and runs any other command.
   */
  const completionFor = (key: "tab" | "return"): Completion | undefined => {
    const chosen = list.chosen();
    if (chosen === undefined) return undefined;
    // A command typed whole, with a space after it, is complete: Enter sends it with its arguments.
    if (isWhole() && hasSpace()) return undefined;
    // Tab leaves a whole command that takes no argument to the chat's own Tab.
    if (key === "tab" && isWhole() && chosen.argument === "none") return undefined;

    if (key === "return" && chosen.argument !== "required")
      return { type: "run", name: chosen.name };

    const completed = chosen.argument === "none" ? chosen.name : `${chosen.name} `;
    return { type: "replace", start: 0, end: text().length, text: completed };
  };

  const keys: SuggestionKeys = {
    kind: "commands",
    completes: () => isOpen() && !(isWhole() && hasSpace()),
    move: list.move,
    dismiss: list.dismiss,
    completionFor,
  };

  return {
    ...keys,
    shown,
    selected: list.selected,
    isOpen,
    setText: (now: string) => {
      if (now === text()) return;
      setText(now);
      list.reset();
    },
  };
};
