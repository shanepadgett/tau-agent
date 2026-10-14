/** Writes notes and memory beside the agent, waking on completed work. The session scope cancels unfinished work. */

import { Effect, PubSub, type Scope } from "effect";
import { Catalog } from "../../../../ai/Catalog.ts";
import { Models } from "../../../../ai/Models.ts";
import type { SessionId } from "../../../../session/Entry.ts";
import { Notes } from "../../../../session/Notes.ts";
import { Sessions } from "../../../../session/Sessions.ts";
import type { AgentEvent } from "../../../Client.ts";
import { ContextSettings } from "../../../ContextSettings.ts";
import { dreamNext } from "./dream.ts";
import { type NoteServices, writeNextNote } from "./note-writer.ts";

export const makeContextWorker = Effect.fn("makeContextWorker")(function* () {
  const services: NoteServices = {
    sessions: yield* Sessions,
    notes: yield* Notes,
    catalog: yield* Catalog,
    models: yield* Models,
    settings: yield* ContextSettings,
  };

  return Effect.fn("startContextWorker")(function* (
    session: SessionId,
    subscribe: Effect.Effect<PubSub.Subscription<AgentEvent>, never, Scope.Scope>,
  ) {
    const events = yield* subscribe;

    const wake = Effect.gen(function* () {
      const batch = yield* PubSub.takeAll(events);

      if (batch.some((event) => event.type === "tool-ended" || event.type === "run-ended"))
        yield* catchUp(services, session);
    });

    yield* Effect.forkScoped(catchUp(services, session).pipe(Effect.andThen(Effect.forever(wake))));
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
