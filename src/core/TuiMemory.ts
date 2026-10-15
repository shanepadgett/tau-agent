/** What the chat in the terminal remembers between runs of Tau, such as whether the sidebar was open. The CLI gives the file in Tau's home folder; a test gives a temporary one. */

import { Context, type Effect, Schema } from "effect";

/** Whether the user last left the docked sidebar open or closed. */
export type SidebarChoice = "open" | "closed";

export class TuiMemoryError extends Schema.TaggedError<TuiMemoryError>()("TuiMemoryError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export class TuiMemory extends Context.Service<
  TuiMemory,
  {
    /** Open if the user never chose, or if Tau cannot read the choice. */
    readonly sidebar: Effect.Effect<SidebarChoice>;
    readonly saveSidebar: (choice: SidebarChoice) => Effect.Effect<void, TuiMemoryError>;
  }
>()("tau/core/TuiMemory") {}
