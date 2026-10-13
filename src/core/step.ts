/**
 * The agent loop. Each step reads the session's entries and runs the first operation that applies,
 * so a run can stop after any step and continue from the saved entries alone.
 */

import { Effect, Option } from "effect";
import { operations, type Outcome, type RunContext } from "./operations.ts";

const ANSWERED: Outcome = { type: "end", reason: "answered" };

/** One step: the first operation that applies acts; with none, the run has its answer. */
const step = Effect.fn("step")(function* <R>(run: RunContext<R>) {
  const entries = yield* run.sessions.entries(run.session, 0);

  for (const operation of operations(run)) {
    const action = operation(entries);
    if (Option.isSome(action)) return yield* action.value;
  }

  return ANSWERED;
});

/** Runs steps until one ends the run, and gives the reason it ended. */
export const runSteps = Effect.fn("runSteps")(function* <R>(run: RunContext<R>) {
  for (;;) {
    const outcome = yield* step(run);
    if (outcome.type === "end") return outcome.reason;
  }
});
