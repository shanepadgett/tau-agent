/** Builds the notes context method from the session store, catalog and model services. */

import { Effect } from "effect";
import { Catalog, type ModelRef } from "../../../../ai/Catalog.ts";
import type { RunningProcess, SessionId } from "../../../../session/Entry.ts";
import { Memories } from "../../../../session/Memories.ts";
import { Sessions } from "../../../../session/Sessions.ts";
import { ContextSettings } from "../../../ContextSettings.ts";
import { needsReply } from "../../loop/tool-history.ts";
import type { RunMethod } from "../run-method.ts";
import { contextBudget, contextStage } from "./budget.ts";
import { checkpointTool } from "./checkpoint.ts";
import { stageNudge, refuseCallsWhenForced } from "./stage.ts";
import { notesView } from "./view.ts";
import { makeContextWorker, notesWritten } from "./worker.ts";

export const makeNotesMethod = Effect.fn("makeNotesMethod")(function* () {
  const sessions = yield* Sessions;
  const notes = yield* Memories;
  const catalog = yield* Catalog;
  const settings = yield* ContextSettings;
  const background = yield* makeContextWorker();

  const forRun = Effect.fn("notesForRun")(function* (
    session: SessionId,
    model: ModelRef,
    running: Effect.Effect<readonly RunningProcess[]>,
  ) {
    const { profile } = yield* catalog.model(model);
    const budgetTokens = contextBudget(profile, settings);

    const method: RunMethod = {
      view: (soul, entries) =>
        Effect.all([notes.shortTerm(session), notes.longTerm(session)]).pipe(
          Effect.map(([saved, memories]) => notesView(soul, entries, saved, memories)),
        ),
      tools: [checkpointTool({ session, notes, running })],
      nudge: (entries) => stageNudge(entries, budgetTokens),
      operations: [refuseCallsWhenForced({ session, sessions, budgetTokens })],
      shouldReply: (entries) =>
        needsReply(entries) || contextStage(entries, budgetTokens) === "forced",
    };

    return method;
  });

  const history = (session: SessionId) => notes.shortTerm(session).pipe(Effect.map(notesWritten));

  return { forRun, background, history };
});
