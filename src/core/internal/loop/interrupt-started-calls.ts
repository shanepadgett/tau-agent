/**
 * A call that started and has no result was cut short by a crash. Running it again could repeat
 * its effects, so this operation gives it a result that says so.
 */

import { Effect, Option } from "effect";
import { CONTINUE, type Operation, type RunContext } from "./run-context.ts";
import { allCalls, failedResult, resultIds, startedIds } from "./tool-history.ts";

const INTERRUPTED_BY_CRASH = "Interrupted before it finished. It did not run again.";

export const interruptStartedCalls =
  <R>(run: RunContext<R>): Operation<R> =>
  (entries) => {
    const answered = resultIds(entries);
    const started = startedIds(entries);

    const cutShort = allCalls(entries).filter(
      (call) => started.has(call.id) && !answered.has(call.id),
    );

    if (cutShort.length === 0) return Option.none();

    const interruptedResults = cutShort.map((call) => failedResult(call, INTERRUPTED_BY_CRASH));
    const save = run.sessions.append(run.session, interruptedResults);
    return Option.some(save.pipe(Effect.as(CONTINUE)));
  };
