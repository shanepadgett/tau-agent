/** A bordered box with a title on its top edge and key hints on its bottom edge. */

import type { JSX } from "@opentui/solid";
import { TOKENS } from "../tokens.ts";

export function Panel(props: {
  readonly title?: string | undefined;
  readonly hint?: string | undefined;
  readonly children: JSX.Element;
}) {
  return (
    <box
      border
      borderColor={TOKENS.color.accent}
      title={props.title ?? ""}
      bottomTitle={props.hint ?? ""}
      flexDirection="column"
    >
      {props.children}
    </box>
  );
}
