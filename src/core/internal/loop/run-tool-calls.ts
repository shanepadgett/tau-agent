/** Runs the tool calls of the latest reply, one at a time, saving each as started before it runs. */

import { Effect, Option } from "effect";
import { runCall } from "../run-tool/run-tool.ts";
import { CONTINUE, type Operation, type RunContext } from "./run-context.ts";
import { failedResult, openCalls, summary, type ToolCall } from "./tool-history.ts";

const INTERRUPTED_BY_USER = "Interrupted by the user.";

export const runToolCalls =
  <R>(run: RunContext<R>): Operation<R> =>
  (entries) => {
    const calls = openCalls(entries);
    if (calls.length === 0) return Option.none();

    const runAll = Effect.forEach(calls, (call) => runToolCall(run, call));
    return Option.some(runAll.pipe(Effect.as(CONTINUE)));
  };

/**
 * Saves the call as started, runs it and saves its result. A cancel at any point after the start
 * gives the call a result that says so.
 */
const runToolCall = <R>(run: RunContext<R>, call: ToolCall) => {
  const execute = Effect.gen(function* () {
    yield* run.sessions.append(run.session, [{ type: "tool-started", callId: call.id }]);
    yield* run.emit({ type: "tool-started", callId: call.id, summary: summary(call) });

    const scriptResult =
      call.name === "run"
        ? yield* runCall(call.params, run.functions, run.timeouts)
        : { text: `There is no tool named ${call.name}. The only tool is run.`, isFailure: true };

    yield* run.sessions.append(run.session, [
      {
        type: "tool-result",
        callId: call.id,
        name: call.name,
        result: scriptResult.text,
        isFailure: scriptResult.isFailure,
      },
    ]);

    yield* run.emit({ type: "tool-ended", callId: call.id, isFailure: scriptResult.isFailure });
  });

  const saveInterrupted = run.sessions
    .append(run.session, [failedResult(call, INTERRUPTED_BY_USER)])
    .pipe(Effect.ignore({ log: true }));

  return execute.pipe(Effect.onInterrupt(() => saveInterrupted));
};
