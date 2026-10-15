/** Runs the tool calls of the latest reply, one at a time, saving each as started before it runs. */

import { Effect, Option } from "effect";
import type { Entry } from "../../../session/Entry.ts";
import { toolNamed, toolNames, type ToolOutcome } from "../tools/model-tool.ts";
import { CONTINUE, type Operation, type RunContext } from "./run-context.ts";
import { failedResult, openCalls, summary, type ToolCall } from "./tool-history.ts";

const INTERRUPTED_BY_USER = "Interrupted by the user.";

export const runToolCalls =
  <R>(run: RunContext<R>): Operation<R> =>
  (entries) => {
    const calls = openCalls(entries);
    if (calls.length === 0) return Option.none();

    const runAll = Effect.gen(function* () {
      const saved = [...entries];
      for (const call of calls) saved.push(...(yield* runToolCall(run, call, saved)));
    });

    return Option.some(runAll.pipe(Effect.as(CONTINUE)));
  };

/**
 * Saves the call as started, runs it and saves its result. A cancel at any point after the start
 * gives the call a result that says so. `entries` hold the scripts and changes of earlier calls,
 * including those of the same reply. Gives the entries it saved.
 */
const runToolCall = <R>(run: RunContext<R>, call: ToolCall, entries: readonly Entry[]) => {
  const execute = Effect.gen(function* () {
    const started = yield* run.sessions.append(run.session, [
      { type: "tool-started", callId: call.id },
    ]);

    yield* run.emit({
      type: "tool-started",
      callId: call.id,
      name: call.name,
      summary: summary(call),
    });

    const outcome = yield* Option.match(toolNamed(run.tools, call.name), {
      onNone: () => Effect.succeed(unknownTool(run, call)),
      onSome: (tool) => tool.call(call, [...entries, ...started]),
    });

    const ended = yield* run.sessions.append(run.session, [
      {
        type: "tool-result",
        callId: call.id,
        name: call.name,
        result: outcome.text,
        isFailure: outcome.isFailure,
        details: outcome.details,
        images: outcome.images?.length ? outcome.images : undefined,
      },
    ]);

    yield* run.emit({ type: "tool-ended", callId: call.id, isFailure: outcome.isFailure });
    return [...started, ...ended];
  });

  const saveInterrupted = run.sessions
    .append(run.session, [failedResult(call, INTERRUPTED_BY_USER)])
    .pipe(Effect.ignore({ log: true }));

  return execute.pipe(Effect.onInterrupt(() => saveInterrupted));
};

const unknownTool = <R>(run: RunContext<R>, call: ToolCall): ToolOutcome => ({
  text: `There is no tool named ${call.name}. The tools are ${toolNames(run.tools).join(", ")}.`,
  isFailure: true,
  details: undefined,
});
