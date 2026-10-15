/**
 * The look of the new front end: its colors by role. Every primitive and component takes its
 * look from here, so a design change happens in one place.
 */

export const TOKENS = {
  color: {
    background: "#282c34",
    text: "#dddddd",
    muted: "#888888",
    accent: "#61afef",
    success: "#98c379",
    /** The row under the cursor in a list. */
    selected: "#555555",
  },
  /** How opaque the black backdrop behind a dialog is, from 0 to 255. */
  dimAlpha: 150,
} as const;
