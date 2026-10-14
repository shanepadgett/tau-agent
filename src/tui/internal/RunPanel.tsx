/**
 * The place above the input: whether a run is going, and the prompts that wait for it, one line
 * each. A plain first design; it takes no space when no run is going.
 */

import { For, Show } from "solid-js";
import { oneLine } from "./Chat.tsx";
import type { ChatState } from "./chat-state.ts";

export function RunPanel(props: { readonly chat: ChatState }) {
  return (
    <box flexDirection="column">
      <Show when={props.chat.run !== "idle"}>
        <text fg="#888888">{props.chat.run === "retrying" ? "Retrying…" : "Running…"}</text>
      </Show>
      <For each={props.chat.queued}>
        {(queued) => (
          <text wrapMode="none" truncate fg="#888888">
            {`Queued: ${oneLine(queued.text)}`}
          </text>
        )}
      </For>
    </box>
  );
}
