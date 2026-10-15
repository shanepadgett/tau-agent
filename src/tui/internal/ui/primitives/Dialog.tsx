/**
 * A box in the middle of the whole terminal over a dimmed backdrop, such as the `/connect` dialog.
 * It draws the backdrop and the box, closes on a click outside the box, and leaves keys to its owner.
 */

import { RGBA } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { TOKENS } from "../tokens.ts";
import { Panel } from "./Panel.tsx";

/** The narrowest a dialog is, unless the terminal is narrower. */
const MIN_COLUMNS = 52;

/** Above the sidebar drawer, which is at 1. */
const Z_INDEX = 10;

export function Dialog(props: {
  readonly title: string;
  readonly hint?: string | undefined;
  readonly onClose: () => void;
  /** A wider minimum for a dialog whose content is narrow. The dialog still grows with its content. */
  readonly minColumns?: number | undefined;
  readonly children: JSX.Element;
}) {
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      zIndex={Z_INDEX}
      alignItems="center"
      justifyContent="center"
      backgroundColor={RGBA.fromInts(0, 0, 0, TOKENS.dimAlpha)}
      onMouseDown={props.onClose}
    >
      <box
        minWidth={props.minColumns ?? MIN_COLUMNS}
        maxWidth="100%"
        backgroundColor={TOKENS.color.background}
        // A click inside the box is not a click outside it.
        onMouseDown={(event: { stopPropagation: () => void }) => {
          event.stopPropagation();
        }}
      >
        {/* One space more than the border gives, so the title lines up with the content. */}
        <Panel
          title={` ${props.title}`}
          hint={props.hint === undefined ? undefined : `${props.hint} `}
        >
          <box
            flexDirection="column"
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
          >
            {props.children}
          </box>
        </Panel>
      </box>
    </box>
  );
}

/**
 * A row of a list in a dialog. The highlight of the row under the cursor reaches one column into
 * the dialog's side padding on each side; the text stays where the rest of the content is.
 */
export function DialogRow(props: { readonly isSelected: boolean; readonly children: JSX.Element }) {
  return (
    <box
      marginLeft={-1}
      marginRight={-1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.isSelected ? TOKENS.color.selected : "transparent"}
    >
      {props.children}
    </box>
  );
}
