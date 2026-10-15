/** The line under the input: the model of the runs, and the keys that work now. Nothing else goes here. */

import type { ChatClient } from "./chat-client.ts";

const IDLE_KEYS = "enter send · shift+enter new line · ctrl+d quit";
const RUNNING_KEYS = "enter queue · esc cancel · ctrl+d quit";

export function InputFooter(props: { readonly client: ChatClient }) {
  return (
    <box flexDirection="row" justifyContent="space-between" gap={2}>
      <text fg="#888888" flexShrink={0}>
        {props.client.model ?? "no model set"}
      </text>
      <text fg="#888888">{props.client.chat.run === "idle" ? IDLE_KEYS : RUNNING_KEYS}</text>
    </box>
  );
}
