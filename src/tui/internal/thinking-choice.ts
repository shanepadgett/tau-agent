/**
 * The chat's thinking level. The user's choice stays as chosen; the footer shows the nearest level
 * the chat's model offers, and Shift+Tab steps up from that one, wrapping from the top to the bottom.
 */

import { type Accessor, createSignal } from "solid-js";
import { nearestThinking, type RunOptions } from "../../core/Client.ts";

type ThinkingLevel = RunOptions["thinking"];

export type ThinkingChoice = {
  /** The level the user chose, which runs carry. */
  readonly chosen: Accessor<ThinkingLevel>;
  /** The level the model runs at, or undefined when the model offers no levels. */
  readonly shown: Accessor<ThinkingLevel | undefined>;
  readonly step: () => void;
};

export const thinkingChoice = (
  initial: ThinkingLevel,
  offered: Accessor<readonly ThinkingLevel[]>,
): ThinkingChoice => {
  const [chosen, setChosen] = createSignal(initial);
  const shown = () => nearestThinking(offered(), chosen());

  const step = () => {
    const levels = offered();
    const current = shown();
    if (current === undefined) return;

    const next = levels[(levels.indexOf(current) + 1) % levels.length];
    if (next !== undefined) setChosen(next);
  };

  return { chosen, shown, step };
};
