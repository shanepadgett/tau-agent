/** The problems that are true now, one row each above the input editor, until their source clears them. */

import { For } from "solid-js";
import type { Condition, Severity } from "../../core/Status.ts";
import type { ChatClient } from "./chat-client.ts";

const MARKS: Record<Severity, string> = { error: "✗", warning: "!", info: "" };
const COLORS: Record<Severity, string> = { error: "#e06c75", warning: "#e5c07b", info: "#888888" };

export function StatusStrip(props: { readonly client: ChatClient }) {
  return (
    <box flexDirection="column">
      <For each={props.client.conditions()}>
        {(condition) => <ConditionRow condition={condition} />}
      </For>
    </box>
  );
}

/** The mark has its own column, so a long text wraps under its own start. */
function ConditionRow(props: { readonly condition: Condition }) {
  const color = () => COLORS[props.condition.severity];

  return (
    <box flexDirection="row">
      <text width={2} flexShrink={0} fg={color()}>
        {MARKS[props.condition.severity]}
      </text>
      <text flexGrow={1} flexShrink={1} wrapMode="word" fg={color()}>
        {props.condition.text}
      </text>
    </box>
  );
}
