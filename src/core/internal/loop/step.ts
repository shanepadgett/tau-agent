/**
 * The agent loop. Each step reads the session's entries and runs the first operation that applies,
 * so a run can stop after any step and continue from the saved entries alone.
 */

import { Effect, Option } from "effect";
import { callModel } from "./call-model.ts";
import { interruptStartedCalls } from "./interrupt-started-calls.ts";
import type { Operation, Outcome, RunContext } from "./run-context.ts";
import { runToolCalls } from "./run-tool-calls.ts";
import { stopAtTurnLimit } from "./turn-limit.ts";

const ANSWERED: Outcome = { type: "end", reason: "answered" };

/** The operations in the order a step tries them. Calling the model is always last. */
const operations = <R>(run: RunContext<R>): ReadonlyArray<Operation<R>> => [
  interruptStartedCalls(run),
  runToolCalls(run),
  stopAtTurnLimit(run),
  callModel(run),
];

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
