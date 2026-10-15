/**
 * The commands that complete the input's text, above the input while the user types a command. The
 * chosen one has a `▸`.
 */

import { For, Show } from "solid-js";
import type { CommandSuggestions } from "./command-suggestions.ts";
import { COLORS } from "./theme.ts";

/** Room for the `▸` and the space after it. */
const MARK_WIDTH = 2;

export function CommandList(props: { readonly suggestions: CommandSuggestions }) {
  const nameWidth = () =>
    MARK_WIDTH + Math.max(...props.suggestions.shown().map((command) => command.name.length));

  return (
    <Show when={props.suggestions.isOpen()}>
      <box border borderColor={COLORS.accent} title="Commands" flexDirection="column">
        <For each={props.suggestions.shown()}>
          {(command, index) => {
            const isChosen = () => index() === props.suggestions.selected();

            return (
              <box flexDirection="row" gap={2}>
                <text
                  width={nameWidth()}
                  flexShrink={0}
                  fg={isChosen() ? COLORS.accent : COLORS.text}
                >
                  {`${isChosen() ? "▸" : " "} ${command.name}`}
                </text>
                <text wrapMode="none" truncate fg={COLORS.muted}>
                  {command.description}
                </text>
              </box>
            );
          }}
        </For>
      </box>
    </Show>
  );
}
