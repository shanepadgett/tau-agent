/**
 * A table of input texts and the commands the list suggests for them. A unit test because the rule
 * has many input cases; the flow test in `tests/tui/` shows the list on screen.
 */

import { expect, test } from "bun:test";
import { suggestions } from "./command-suggestions.ts";

const COMMANDS = [
  { name: "/model", description: "Change the model for this chat" },
  { name: "/new", description: "Start a new session in this folder" },
  { name: "/sessions", description: "Open an earlier session of this folder" },
];

const cases: ReadonlyArray<readonly [string, string, string[]]> = [
  ["a lone slash suggests every command", "/", ["/model", "/new", "/sessions"]],
  ["the commands that start with the text", "/se", ["/sessions"]],
  ["case is ignored", "/MO", ["/model"]],
  ["a whole command suggests nothing, so Enter sends it", "/model", []],
  ["no command starts with the text", "/xyz", []],
  ["text after a space is a prompt", "/model gpt", []],
  ["text without a slash first is a prompt", "model", []],
  ["an empty input", "", []],
];

for (const [name, text, names] of cases) {
  test(name, () => {
    expect(suggestions(text, COMMANDS).map((command) => command.name)).toEqual(names);
  });
}
