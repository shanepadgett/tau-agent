/**
 * The messages between the supervisor and the Tau it runs. They travel over Bun IPC, and each side
 * parses what it receives with these schemas.
 */

import { Schema } from "effect";

/**
 * A problem with Tau's own code that the chat shows until the supervisor clears it. The chat shows
 * `text` and logs `detail`.
 */
const ReloadCondition = Schema.Struct({
  key: Schema.String,
  severity: Schema.Literals(["error", "warning", "info"]),
  text: Schema.String,
  detail: Schema.String,
});

export type ReloadCondition = typeof ReloadCondition.Type;

export const ToChild = Schema.Union([
  /** Load Tau's code and exit, without opening the database or the terminal. */
  Schema.Struct({ type: Schema.Literal("start-check") }),
  /** Open the chat, with `draft` in the input editor. */
  Schema.Struct({
    type: Schema.Literal("start-chat"),
    draft: Schema.String,
    /** Attention the previous chat held for the reload; the new chat requests it once it is up. */
    attention: Schema.optionalKey(Schema.String),
  }),
  /** Send a handoff and exit, so the supervisor can start the new build. */
  Schema.Struct({ type: Schema.Literal("exit-for-restart") }),
  /** Request attention now: no reload is coming, so the chat has what the user should see. */
  Schema.Struct({ type: Schema.Literal("deliver-attention"), message: Schema.String }),
  /** All of the supervisor's conditions now; one that is not in the list has cleared. */
  Schema.Struct({
    type: Schema.Literal("conditions"),
    conditions: Schema.Array(ReloadCondition),
  }),
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
  /**
   * A run ended and the user should come back. The supervisor holds it while new code builds,
   * checks or switches, so that the user is called to the chat that has the result.
   */
  Schema.Struct({ type: Schema.Literal("attention"), message: Schema.String }),
  CheckFailedMessage,
  Schema.Struct({
    type: Schema.Literal("handoff"),
    session: Schema.String,
    draft: Schema.String,
  }),
]);

export type ToSupervisor = typeof ToSupervisor.Type;
