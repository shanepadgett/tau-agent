/**
 * The place above the input: whether a run is going, and the steering messages and prompts that
 * wait for it, one line each. A plain first design; it takes no space when no run is going.
 */

import { For, Show } from "solid-js";
import { oneLine } from "./Chat.tsx";
import type { ChatState, QueuedPrompt } from "./chat-state.ts";
import { COLORS } from "./theme.ts";

export function RunPanel(props: { readonly chat: ChatState }) {
  return (
    <box flexDirection="column">
      <Show when={props.chat.run !== "idle"}>
        <text fg={COLORS.muted}>{props.chat.run === "retrying" ? "Retrying…" : "Running…"}</text>
      </Show>
      <Waiting label="Steering" waiting={props.chat.steering} />
      <Waiting label="Queued" waiting={props.chat.queued} />
    </box>
  );
}

function Waiting(props: { readonly label: string; readonly waiting: readonly QueuedPrompt[] }) {
  return (
    <For each={props.waiting}>
      {(waiting) => (
        <text wrapMode="none" truncate fg={COLORS.muted}>
          {`${props.label}: ${oneLine(waiting.text)}`}
        </text>
      )}
    </For>
  );
}
