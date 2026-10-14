/** Builds the notes context method from the session store, catalog and model services. */

import { Effect } from "effect";
import { Catalog, type ModelRef } from "../../../../ai/Catalog.ts";
import type { SessionId } from "../../../../session/Entry.ts";
import { Notes } from "../../../../session/Notes.ts";
import { Sessions } from "../../../../session/Sessions.ts";
import { ContextSettings } from "../../../ContextSettings.ts";
import { needsReply } from "../../loop/tool-history.ts";
import type { RunMethod } from "../run-method.ts";
import { contextBudget, contextStage } from "./budget.ts";
import { checkpointTool } from "./checkpoint.ts";
import { makeNoteWriter } from "./note-writer.ts";
import { stageNudge, refuseCallsWhenForced } from "./stage.ts";
import { notesView } from "./view.ts";

export const makeNotesMethod = Effect.fn("makeNotesMethod")(function* () {
  const sessions = yield* Sessions;
  const notes = yield* Notes;
  const catalog = yield* Catalog;
  const settings = yield* ContextSettings;
  const background = yield* makeNoteWriter();

  const forRun = Effect.fn("notesForRun")(function* (session: SessionId, model: ModelRef) {
    const { profile } = yield* catalog.model(model);
    const budgetTokens = contextBudget(profile, settings);

    const method: RunMethod = {
      view: (soul, entries) =>
        notes.list(session).pipe(Effect.map((saved) => notesView(soul, entries, saved))),
      tools: [checkpointTool(session, notes)],
      nudge: (entries) => stageNudge(entries, budgetTokens),
      operations: [refuseCallsWhenForced({ session, sessions, budgetTokens })],
      shouldReply: (entries) =>
        needsReply(entries) || contextStage(entries, budgetTokens) === "forced",
    };

    return method;
  });

  return { forRun, background };
});
