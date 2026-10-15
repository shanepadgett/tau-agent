/**
 * The line under the input: the model of the runs and its thinking level, what its calls used and
 * cost, and the keys that work now. Nothing else goes here.
 */

import { useKeymapSelector } from "@opentui/keymap/solid";
import type { ChatClient } from "./chat-client.ts";
import type { Usage } from "./chat-state.ts";
import type { CommandSuggestions } from "./command-suggestions.ts";
import { keyText, type TauKeymap } from "./keymap.ts";
import { COLORS } from "./theme.ts";

/** A hint: the commands whose first keys show side by side, and what they do. */
type Hint = readonly [commands: readonly string[], text: string];

const IDLE_HINTS: readonly Hint[] = [
  [["input.submit"], "send"],
  [["input.newline"], "new line"],
  [["chat.quit"], "quit"],
];

const IDLE_THINKING_HINTS: readonly Hint[] = [
  [["input.submit"], "send"],
  [["input.newline"], "new line"],
  [["thinking.next"], "thinking"],
  [["chat.quit"], "quit"],
];

const RUNNING_HINTS: readonly Hint[] = [
  [["input.submit"], "steer"],
  [["prompt.queue"], "queue"],
  [["run.cancel"], "cancel"],
  [["chat.quit"], "quit"],
];

const LIST_HINTS: readonly Hint[] = [
  [["list.up", "list.down"], "move"],
  [["list.complete"], "complete"],
  [["list.choose"], "select"],
  [["list.close"], "close"],
];

const TOKENS_PER_K = 1000;

export function InputFooter(props: {
  readonly client: ChatClient;
  readonly suggestions: CommandSuggestions;
}) {
  // The keys come from the key map, so a hint shows the key that works. Bindings register after
  // the first draw, so the hints follow the key map's changes.
  const hints = useKeymapSelector((keymap) => ({
    idle: hintsText(keymap, IDLE_HINTS),
    idleThinking: hintsText(keymap, IDLE_THINKING_HINTS),
    running: hintsText(keymap, RUNNING_HINTS),
    list: hintsText(keymap, LIST_HINTS),
  }));

  const keys = () => {
    if (props.suggestions.completes()) return hints().list;
    if (props.client.chat.run !== "idle") return hints().running;
    return props.client.thinking() === undefined ? hints().idle : hints().idleThinking;
  };

  const usage = () => {
    const known = props.client.chat.usage;
    return known === undefined ? "" : ` · ${usageText(known)}`;
  };

  const level = () => {
    const thinking = props.client.thinking();
    return thinking === undefined ? "" : ` (${thinking})`;
  };

  return (
    <box flexDirection="row" justifyContent="space-between" gap={2}>
      <text fg={COLORS.muted} flexShrink={0}>
        {props.client.model() ?? "no model set"}
        {level()}
        {usage()}
      </text>
      <text fg={COLORS.muted}>{keys()}</text>
    </box>
  );
}

/** Such as `enter send · shift+enter new line`. */
const hintsText = (keymap: TauKeymap, hints: readonly Hint[]) =>
  hints
    .map(
      ([commands, text]) =>
        `${commands.map((command) => keyText(keymap, command)).join("")} ${text}`,
    )
    .join(" · ");

/** Such as `42k/200k · $0.84`: the context of the latest call, the limit, and the cost so far. */
const usageText = (usage: Usage) => {
  const context = `${tokenText(usage.contextUsed)}/${tokenText(usage.contextTokens)}`;
  return usage.cost === undefined ? context : `${context} · $${usage.cost.toFixed(2)}`;
};

/** A token count in thousands, such as `200k`. */
const tokenText = (tokens: number) => `${Math.round(tokens / TOKENS_PER_K)}k`;
