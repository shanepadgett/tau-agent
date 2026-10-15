/**
 * The line under the input: the model of the runs and its thinking level, and the keys that work
 * now. Nothing else goes here; what the calls used and cost shows in the sidebar.
 */

import { useKeymapSelector } from "@opentui/keymap/solid";
import type { Accessor } from "solid-js";
import type { ChatClient } from "./chat-client.ts";
import { keyText, type TauKeymap } from "./keymap.ts";
import type { InputSuggestions } from "./suggestion-list.ts";
import { COLORS } from "./theme.ts";

/** A hint: the commands whose first keys show side by side, and what they do. */
type Hint = readonly [commands: readonly string[], text: string];

/** The quit hint, which the stash hint takes the place of while the input holds text. */
const QUIT_HINT: Hint = [["chat.quit"], "quit"];
const STASH_HINT: Hint = [["prompt.stash"], "stash"];

const IDLE_HINTS: readonly Hint[] = [
  [["input.submit"], "send"],
  [["input.newline"], "new line"],
  QUIT_HINT,
];

const IDLE_THINKING_HINTS: readonly Hint[] = [
  [["input.submit"], "send"],
  [["input.newline"], "new line"],
  [["thinking.next"], "thinking"],
  QUIT_HINT,
];

const RUNNING_HINTS: readonly Hint[] = [
  [["input.submit"], "steer"],
  [["prompt.queue"], "queue"],
  [["run.cancel"], "cancel"],
  QUIT_HINT,
];

const COMMAND_LIST_HINTS: readonly Hint[] = [
  [["list.up", "list.down"], "move"],
  [["list.complete"], "complete"],
  [["list.choose"], "select"],
  [["list.close"], "close"],
];

const FILE_LIST_HINTS: readonly Hint[] = [
  [["list.up", "list.down"], "move"],
  [["list.complete"], "open folder"],
  [["list.choose"], "tag"],
  [["list.close"], "close"],
];

/** Shown before the quit key while the line has room for it. */
const SIDEBAR_HINT: Hint = [["sidebar.toggle"], "sidebar"];

/** The columns between the model and the keys. */
const GAP = 2;

export function InputFooter(props: {
  readonly client: ChatClient;
  readonly suggestions: InputSuggestions;
  /** The width of the line. */
  readonly columns: Accessor<number>;
}) {
  // The keys come from the key map, so a hint shows the key that works. Bindings register after
  // the first draw, so the hints follow the key map's changes.
  const hints = useKeymapSelector((keymap) => ({
    idle: choicesText(keymap, IDLE_HINTS),
    idleThinking: choicesText(keymap, IDLE_THINKING_HINTS),
    running: choicesText(keymap, RUNNING_HINTS),
    idleDraft: choicesText(keymap, withStash(IDLE_HINTS)),
    idleThinkingDraft: choicesText(keymap, withStash(IDLE_THINKING_HINTS)),
    runningDraft: choicesText(keymap, withStash(RUNNING_HINTS)),
    commands: [hintsText(keymap, COMMAND_LIST_HINTS)],
    files: [hintsText(keymap, FILE_LIST_HINTS)],
  }));

  const choices = () => {
    const list = props.suggestions.open();
    if (list?.completes() === true) return hints()[list.kind];
    const draft = props.client.hasDraft();
    if (props.client.chat.run !== "idle") return draft ? hints().runningDraft : hints().running;
    if (props.client.thinking() === undefined) return draft ? hints().idleDraft : hints().idle;
    return draft ? hints().idleThinkingDraft : hints().idleThinking;
  };

  const level = () => {
    const thinking = props.client.thinking();
    return thinking === undefined ? "" : ` (${thinking})`;
  };

  const model = () => `${props.client.model() ?? "no model set"}${level()}`;

  // The first choice that fits beside the model, or else the last.
  const keys = () => {
    const room = props.columns() - model().length - GAP;
    const all = choices();
    return all.find((text) => text.length <= room) ?? all.at(-1) ?? "";
  };

  return (
    <box flexDirection="row" justifyContent="space-between" gap={GAP}>
      <text fg={COLORS.muted} flexShrink={0}>
        {model()}
      </text>
      <text fg={COLORS.muted}>{keys()}</text>
    </box>
  );
}

const withStash = (hints: readonly Hint[]) =>
  hints.map((hint) => (hint === QUIT_HINT ? STASH_HINT : hint));

/** Such as `enter send · shift+enter new line`. */
const hintsText = (keymap: TauKeymap, hints: readonly Hint[]) =>
  hints
    .map(
      ([commands, text]) =>
        `${commands.map((command) => keyText(keymap, command)).join("")} ${text}`,
    )
    .join(" · ");

/** The hints with the sidebar's key, for a line with room for it, then without it. */
const choicesText = (keymap: TauKeymap, hints: readonly Hint[]) => [
  hintsText(keymap, [...hints.slice(0, -1), SIDEBAR_HINT, ...hints.slice(-1)]),
  hintsText(keymap, hints),
];
