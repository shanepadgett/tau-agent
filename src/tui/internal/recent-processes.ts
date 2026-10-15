/** The sidebar's process list: a command that ended stays a minute, so the user sees how it ended, then it goes. */

import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import type { ChatProcesses } from "./chat-state.ts";

const ENDED_SHOWN_MILLIS = 60_000;

/**
 * The commands to show: every running one, and each ended one until `shownMillis` after the
 * list first showed it ended. Core keeps ended commands, because the model can still read their
 * output; only the sidebar lets them go.
 */
export const recentProcesses = (
  processes: Accessor<ChatProcesses>,
  shownMillis = ENDED_SHOWN_MILLIS,
): Accessor<ChatProcesses> => {
  const [gone, setGone] = createSignal<ReadonlySet<string>>(new Set());
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  createEffect(() => {
    for (const { id, state } of processes()) {
      if (state.type === "running" || timers.has(id)) continue;

      const hide = () => {
        setGone((ids) => new Set([...ids, id]));
      };

      timers.set(id, setTimeout(hide, shownMillis));
    }
  });

  onCleanup(() => {
    for (const timer of timers.values()) clearTimeout(timer);
  });

  return () => processes().filter(({ id }) => !gone().has(id));
};
