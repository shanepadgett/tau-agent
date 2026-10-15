/**
 * One choice in a dialog list: the name at the left, a muted hint and a green check at the right.
 * The check has its own column, so the name and the hint do not move when it shows.
 */

import { Show } from "solid-js";
import { TOKENS } from "../tokens.ts";
import { DialogRow } from "../primitives/Dialog.tsx";

export function ChoiceRow(props: {
  readonly label: string;
  /** How, such as "browser"; shown muted before the check. */
  readonly hint?: string | undefined;
  readonly isSignedIn: boolean;
  readonly isSelected: boolean;
}) {
  return (
    <DialogRow isSelected={props.isSelected}>
      <box flexDirection="row" justifyContent="space-between">
        <text
          wrapMode="none"
          truncate
          flexShrink={1}
          fg={props.isSelected ? TOKENS.color.accent : TOKENS.color.text}
        >
          {props.label}
        </text>
        <box flexDirection="row" flexShrink={0}>
          <Show when={props.hint}>
            {(hint) => (
              <text wrapMode="none" fg={TOKENS.color.muted}>
                {hint()}
              </text>
            )}
          </Show>
          <text wrapMode="none" fg={TOKENS.color.success}>
            {props.isSignedIn ? " ✓" : "  "}
          </text>
        </box>
      </box>
    </DialogRow>
  );
}
