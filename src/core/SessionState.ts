/** The state of an open chat, including the metadata and choices of an unsaved draft. */

import type { Session } from "../session/Sessions.ts";

export type SessionState =
  | { readonly kind: "draft"; readonly session: Session; readonly references: readonly string[] }
  | { readonly kind: "saved"; readonly session: Session };
