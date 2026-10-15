/** Writes notes and memory beside the agent, waking on completed work. The session scope cancels unfinished work. */

import { Effect, PubSub, Ref } from "effect";
import { Models } from "../../../../ai/Models.ts";
import type { SessionId } from "../../../../session/Entry.ts";
import { type Note, Notes } from "../../../../session/Notes.ts";
import { Sessions } from "../../../../session/Sessions.ts";
import type { AgentEvent } from "../../../Client.ts";
import { ContextSettings } from "../../../ContextSettings.ts";
import { dreamNext } from "./dream.ts";
import { type NoteServices, writeNextNote } from "./note-writer.ts";

export const makeContextWorker = Effect.fn("makeContextWorker")(function* () {
  const services: NoteServices = {
    sessions: yield* Sessions,
    notes: yield* Notes,
    models: yield* Models,
    settings: yield* ContextSettings,
  };

  return Effect.fn("startContextWorker")(function* (
    session: SessionId,
    events: PubSub.PubSub<AgentEvent>,
  ) {
    const subscription = yield* PubSub.subscribe(events);
    const covered = yield* Ref.make(0);

    // A client shows how far the notes reach, so each catch-up that moves them tells it.
    const report = services.notes.list(session).pipe(
      Effect.flatMap((notes) =>
        Effect.forEach(notesWritten(notes), (event) =>
          Ref.getAndSet(covered, event.through).pipe(
            Effect.flatMap((before) =>
              before === event.through ? Effect.void : PubSub.publish(events, event),
            ),
          ),
        ),
      ),
      Effect.catch((error) => Effect.logWarning("Could not read the session's notes.", error)),
    );

    const work = catchUp(services, session).pipe(Effect.andThen(report));

    const wake = Effect.gen(function* () {
      const batch = yield* PubSub.takeAll(subscription);

      if (batch.some((event) => event.type === "tool-ended" || event.type === "run-ended"))
        yield* work;
    });

    yield* Effect.forkScoped(work.pipe(Effect.andThen(Effect.forever(wake))));
  });
});

/** Writes every due note, then every due memory, until neither is due. */
const catchUp = Effect.fn("catchUpContext")(
  function* (services: NoteServices, session: SessionId) {
    while ((yield* writeNextNote(services, session)) || (yield* dreamNext(services, session)))
      continue;
  },
  Effect.catch((error) =>
    Effect.logWarning(
      "Could not write background notes or memory; the next completed tool call or run will retry.",
      error,
    ),
  ),
);

type NotesWritten = Extract<AgentEvent, { type: "notes-written" }>;

/** How far the notes reach, as an event, or none before the first note. */
export const notesWritten = (notes: readonly Note[]): readonly NotesWritten[] => {
  const last = notes.at(-1);
  return last === undefined ? [] : [{ type: "notes-written", through: last.through }];
};
