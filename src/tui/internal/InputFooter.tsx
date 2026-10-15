/**
 * The line under the input: the model of the runs and its thinking level, what its calls used and
 * cost, and the keys that work now. Nothing else goes here.
 */

import type { ChatClient } from "./chat-client.ts";
import type { Usage } from "./chat-state.ts";
import type { CommandSuggestions } from "./command-suggestions.ts";
import { COLORS } from "./theme.ts";

const IDLE_KEYS = "enter send · shift+enter new line · ctrl+d quit";
const IDLE_THINKING_KEYS = "enter send · shift+enter new line · shift+tab thinking · ctrl+d quit";
const RUNNING_KEYS = "enter steer · tab queue · esc cancel · ctrl+d quit";
const LIST_KEYS = "↑↓ move · tab/enter complete · esc close";
const TOKENS_PER_K = 1000;

export function InputFooter(props: {
  readonly client: ChatClient;
  readonly suggestions: CommandSuggestions;
}) {
  const keys = () => {
    if (props.suggestions.isOpen()) return LIST_KEYS;
    if (props.client.chat.run !== "idle") return RUNNING_KEYS;
    return props.client.thinking() === undefined ? IDLE_KEYS : IDLE_THINKING_KEYS;
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

/** Such as `42k/200k · $0.84`: the context of the latest call, the limit, and the cost so far. */
const usageText = (usage: Usage) => {
  const context = `${tokenText(usage.contextUsed)}/${tokenText(usage.contextTokens)}`;
  return usage.cost === undefined ? context : `${context} · $${usage.cost.toFixed(2)}`;
};

/** A token count in thousands, such as `200k`. */
const tokenText = (tokens: number) => `${Math.round(tokens / TOKENS_PER_K)}k`;
