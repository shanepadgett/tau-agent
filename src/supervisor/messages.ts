/**
 * The messages between the supervisor and the Tau it runs. They travel over Bun IPC, and each side
 * parses what it receives with these schemas.
 */

import { Schema } from "effect";

export const ToChild = Schema.Union([
  /** Load Tau's code and exit, without opening the database or the terminal. */
  Schema.Struct({ type: Schema.Literal("start-check") }),
  /** Open the chat, with `draft` in the input editor. */
  Schema.Struct({ type: Schema.Literal("start-chat"), draft: Schema.String }),
  Schema.Struct({ type: Schema.Literal("notice"), text: Schema.String }),
  /** Send a handoff and exit, so the supervisor can start the new build. */
  Schema.Struct({ type: Schema.Literal("exit-for-restart") }),
]);

export type ToChild = typeof ToChild.Type;

/**
 * From the start check: why the new code did not load. It travels over IPC because a process that
 * exits at once can lose what it wrote to a pipe.
 */
export const CheckFailedMessage = Schema.Struct({
  type: Schema.Literal("check-failed"),
  reason: Schema.String,
});

export const ToSupervisor = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready"), session: Schema.String }),
  /** Idle means that no run is going and no prompt waits. */
  Schema.Struct({ type: Schema.Literal("idle"), idle: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("restart-request") }),
  CheckFailedMessage,
  Schema.Struct({
    type: Schema.Literal("handoff"),
    session: Schema.String,
    draft: Schema.String,
  }),
]);

export type ToSupervisor = typeof ToSupervisor.Type;
