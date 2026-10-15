/**
 * A named place on the chat screen, such as `chat` or `input.editor`. A failure inside a place
 * shows where the place was, and the rest of the screen keeps working.
 */

import type { JSX } from "@opentui/solid";
import { ErrorBoundary } from "solid-js";
import { COLORS } from "./theme.ts";

export function Place(props: { readonly name: string; readonly children: JSX.Element }) {
  return (
    // Solid gives the fallback an Error even when something else was thrown.
    <ErrorBoundary
      fallback={(error: Error) => (
        <text fg={COLORS.error}>{`${props.name} failed: ${error.message}`}</text>
      )}
    >
      {props.children}
    </ErrorBoundary>
  );
}
