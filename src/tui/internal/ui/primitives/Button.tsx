/**
 * A one-row label the user clicks with the mouse. It has a solid background, so text under it
 * does not show through, and its text takes the accent color while the pointer is over it.
 */

import { createSignal } from "solid-js";
import { TOKENS } from "../tokens.ts";

export function Button(props: { readonly label: string; readonly onPress: () => void }) {
  const [isHovered, setIsHovered] = createSignal(false);

  return (
    <box
      backgroundColor={TOKENS.color.background}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={props.onPress}
      onMouseOver={() => setIsHovered(true)}
      onMouseOut={() => setIsHovered(false)}
    >
      <text fg={isHovered() ? TOKENS.color.accent : TOKENS.color.text}>{props.label}</text>
    </box>
  );
}
