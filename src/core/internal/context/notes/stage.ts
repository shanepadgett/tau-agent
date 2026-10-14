/** Sends one hidden nudge per context stage and blocks other tool calls at the budget. */

import { Effect, Option } from "effect";
import type { Entry, NudgeEntry, SessionId } from "../../../../session/Entry.ts";
import type { Sessions } from "../../../../session/Sessions.ts";
import { CONTINUE, type Operation } from "../../loop/run-context.ts";
import { failedResult, openCalls } from "../../loop/tool-history.ts";
import { contextStage } from "./budget.ts";
import { latestCheckpoint } from "./view.ts";

const STAGE_TEXT = {
  notice:
    "Context notice. The context has reached half its budget. Continue active work; checkpoint is available when useful.",
  warning:
    "Context warning. The context has reached three quarters of its budget. Finish the current bounded piece of work, then call checkpoint alone with your handoff before starting another substantial piece.",
  forced:
    "The context has reached its budget. All tools except checkpoint are blocked until you call checkpoint alone with your handoff. Call it now.",
};

export const stageNudge = (
  entries: readonly Entry[],
  budgetTokens: number,
): Option.Option<NudgeEntry> => {
  const stage = contextStage(entries, budgetTokens);
  if (stage === "none") return Option.none();
  const checkpoint = latestCheckpoint(entries);
  const key = `context-stage:${stage}`;

  const alreadySent = entries.some(
    ({ number, body }) =>
      number > (checkpoint?.entry.number ?? 0) && body.type === "nudge" && body.key === key,
  );

  return alreadySent ? Option.none() : Option.some({ type: "nudge", key, text: STAGE_TEXT[stage] });
};

type ContextRun = {
  readonly session: SessionId;
  readonly sessions: Sessions["Service"];
  readonly budgetTokens: number;
};

export const refuseCallsWhenForced =
  (run: ContextRun): Operation<never> =>
  (entries) => {
    if (contextStage(entries, run.budgetTokens) !== "forced") return Option.none();
    const calls = openCalls(entries).filter((call) => call.name !== "checkpoint");
    if (calls.length === 0) return Option.none();

    return Option.some(
      run.sessions
        .append(
          run.session,
          calls.map((call) =>
            failedResult(
              call,
              "All tools except checkpoint are blocked. Call checkpoint alone with your handoff.",
            ),
          ),
        )
        .pipe(Effect.as(CONTINUE)),
    );
  };
