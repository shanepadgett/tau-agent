/** Keeps draft choices in memory and saves a session with its first user prompt in one transaction. */

import { Effect, PubSub, Ref, Semaphore } from "effect";
import type { EntryBody } from "../../../session/Entry.ts";
import type { Sessions } from "../../../session/Sessions.ts";
import type { AgentEvent } from "../../Client.ts";
import type { SessionState } from "../../SessionState.ts";

export const sessionPersistence = Effect.fn("sessionPersistence")(function* (
  sessions: Sessions["Service"],
  initial: SessionState,
  events: PubSub.PubSub<AgentEvent>,
) {
  const state = yield* Ref.make(initial);
  const writer = yield* Semaphore.make(1);
  const snapshot = Ref.get(state);

  const savePrompt = (bodies: readonly EntryBody[]) =>
    Effect.gen(function* () {
      const current = yield* snapshot;

      if (current.kind === "saved") {
        yield* sessions.append(current.session.id, bodies);
        return false;
      }

      const references: readonly EntryBody[] =
        current.references.length === 0 ? [] : [{ type: "references", names: current.references }];

      // Commit and the in-memory transition cannot be separated by cancellation.
      yield* sessions
        .start(current.session, [...references, ...bodies])
        .pipe(
          Effect.andThen(Ref.set(state, { kind: "saved", session: current.session })),
          Effect.uninterruptible,
        );

      return true;
    }).pipe(Semaphore.withPermit(writer));

  const setReferences = (names: readonly string[]) =>
    Effect.gen(function* () {
      const current = yield* snapshot;

      if (current.kind === "draft") {
        yield* Ref.set(state, { ...current, references: names });
      } else {
        yield* sessions.append(current.session.id, [{ type: "references", names }]);
      }

      yield* PubSub.publish(events, { type: "references-changed", names });
    }).pipe(Semaphore.withPermit(writer), Effect.asVoid);

  const history = Effect.gen(function* () {
    const current = yield* snapshot;

    return current.kind === "draft" && current.references.length > 0
      ? [{ type: "references-changed" as const, names: current.references }]
      : [];
  });

  return { snapshot, savePrompt, references: { set: setReferences }, history };
});
