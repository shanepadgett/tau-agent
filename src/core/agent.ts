/**
 * The agent: opens sessions for runs and runs each prompt through the agent loop. Clients of one
 * session share its runner, so the session has one writer.
 */

import { Context, Effect, FileSystem, Layer, Option, RcMap, type Scope } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { Models } from "../ai/Models.ts";
import type { SessionId } from "../session/Entry.ts";
import { type SessionNotFound, Sessions, type SessionStoreError } from "../session/Sessions.ts";
import { makeRunner, type OpenSession, type RunServices } from "./internal/runner/runner.ts";
import { UserInstructions } from "./UserInstructions.ts";

export type { OpenSession } from "./internal/runner/runner.ts";

export class Agent extends Context.Service<
  Agent,
  {
    /**
     * Opens an existing session by ID, or a new one in `directory`. It stays open for runs until
     * the caller's scope closes.
     */
    readonly open: (
      session: Option.Option<SessionId>,
      directory: string,
    ) => Effect.Effect<OpenSession, SessionNotFound | SessionStoreError, Scope.Scope>;
  }
>()("tau/core/Agent") {
  static readonly layer = Layer.effect(
    Agent,
    Effect.gen(function* () {
      const services: RunServices = {
        sessions: yield* Sessions,
        models: yield* Models,
        fileSystem: yield* FileSystem.FileSystem,
        spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        userInstructions: (yield* UserInstructions).files,
      };

      const runners = yield* RcMap.make({ lookup: (id: SessionId) => makeRunner(services, id) });

      const open = Effect.fn("Agent.open")(function* (
        session: Option.Option<SessionId>,
        directory: string,
      ) {
        const id = Option.isSome(session)
          ? session.value
          : (yield* services.sessions.create(directory)).id;

        return yield* RcMap.get(runners, id);
      });

      return Agent.of({ open });
    }),
  );
}
