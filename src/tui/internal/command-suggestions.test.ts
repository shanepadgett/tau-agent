/**
 * A table of input texts and the commands the list suggests for them. A unit test because the rule
 * has many input cases; the flow test in `tests/tui/` shows the list on screen.
 */

import { expect, test } from "bun:test";
import { type CommandInfo, suggestions } from "./command-suggestions.ts";

const COMMANDS: readonly CommandInfo[] = [
  { name: "/model", description: "Change the model for this chat", argument: "none" },
  { name: "/new", description: "Start a new session in this folder", argument: "none" },
  {
    name: "/sessions",
    description: "Open an earlier session of this folder",
    argument: "none",
  },
];

const cases: ReadonlyArray<readonly [string, string, string[]]> = [
  ["a lone slash suggests every command", "/", ["/model", "/new", "/sessions"]],
  ["the commands that start with the text", "/se", ["/sessions"]],
  ["case is ignored", "/MO", ["/model"]],
  ["a whole command is still suggested", "/model", ["/model"]],
  ["the whole command comes first", "/ne", ["/new"]],
  ["a space after the command keeps it listed", "/model ", ["/model"]],
  ["arguments keep it listed", "/model gpt", ["/model"]],
  ["no command starts with the text", "/xyz", []],
  ["a space after an unknown command lists nothing", "/xyz ", []],
  ["text without a slash first is a prompt", "model", []],
  ["an empty input", "", []],
];

for (const [name, text, names] of cases) {
  test(name, () => {
    expect(suggestions(text, COMMANDS).map((command) => command.name)).toEqual(names);
  });
}
