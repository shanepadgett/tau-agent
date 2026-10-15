/**
 * The agent: opens sessions for runs and runs each prompt through the agent loop. Clients of one
 * session share its runner, so the session has one writer.
 */

import {
  Context,
  Crypto,
  Effect,
  Equal,
  Hash,
  FileSystem,
  Layer,
  Option,
  Predicate,
  RcMap,
  type Scope,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import type { ListedModel, ModelRef } from "../ai/Catalog.ts";
import type { CredentialStoreError } from "../ai/Credential.ts";
import { Models } from "../ai/Models.ts";
import { makeWriteQueue } from "../sandbox/WriteQueue.ts";
import type { SessionId } from "../session/Entry.ts";
import { type ListedSession, type SessionNotFound, Sessions } from "../session/Sessions.ts";
import type { SessionStoreError } from "../session/SessionStoreError.ts";
import { SkillUses } from "../session/SkillUses.ts";
import { makeFileProblems } from "./internal/instructions/file-problems.ts";
import { makeRunner, type OpenSession, type RunServices } from "./internal/runner/runner.ts";
import { Status } from "./Status.ts";
import { UserInstructions } from "./UserInstructions.ts";
import { OutputFolder } from "./OutputFolder.ts";
import { ContextMethod } from "./ContextMethod.ts";
import { FavoriteModels, type FavoriteModelsError } from "./FavoriteModels.ts";
import { CommitSettings } from "./Commits.ts";
import { Web } from "./Web.ts";
import { References } from "./References.ts";
import { FileTags } from "./FileTags.ts";
import { Connections } from "./Connections.ts";
import { Stashes } from "./Stashes.ts";
import { type SidebarChoice, TuiMemory, type TuiMemoryError } from "./TuiMemory.ts";

import type { SessionState } from "./SessionState.ts";

export type { OpenSession } from "./internal/runner/runner.ts";

export class Agent extends Context.Service<
  Agent,
  {
    /**
     * Opens an existing session by ID, or a new one in `directory`. It stays open for runs until
     * the caller's scope closes.
     */
    readonly open: (
      session: Option.Option<SessionId | Extract<SessionState, { kind: "draft" }>>,
      directory: string,
    ) => Effect.Effect<OpenSession, SessionNotFound | SessionStoreError, Scope.Scope>;
    /** The sessions of `directory`, the latest first. */
    readonly sessions: (
      directory: string,
    ) => Effect.Effect<readonly ListedSession[], SessionStoreError>;
    /** The models Tau can call now. */
    readonly models: Effect.Effect<readonly ListedModel[], CredentialStoreError>;
    /** The models the user keeps at the top of `/model`. */
    readonly favoriteModels: Effect.Effect<readonly ModelRef[]>;
    /** Makes `ref` a favorite, or stops it being one, and gives the new list. */
    readonly toggleFavoriteModel: (
      ref: ModelRef,
    ) => Effect.Effect<readonly ModelRef[], FavoriteModelsError>;
    /** Whether the user last left the chat's docked sidebar open or closed. */
    readonly sidebarChoice: Effect.Effect<SidebarChoice>;
    /** The library of reference repositories. */
    readonly references: References["Service"];
    /** The providers to sign in to and out of. */
    readonly connections: Connections["Service"];
    /** The prompts parked with Ctrl+S. */
    readonly stashes: Stashes["Service"];
    /** The files, folders and references that `@` tags. */
    readonly files: FileTags["Service"];
    readonly saveSidebarChoice: (choice: SidebarChoice) => Effect.Effect<void, TuiMemoryError>;
  }
>()("tau/core/Agent") {
  static readonly layer = Layer.effect(
    Agent,
    Effect.gen(function* () {
      const services: RunServices = {
        sessions: yield* Sessions,
        models: yield* Models,
        contextMethod: yield* ContextMethod,
        fileSystem: yield* FileSystem.FileSystem,
        spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        userInstructions: yield* UserInstructions,
        skillUses: yield* SkillUses,
        outputFolder: yield* OutputFolder,
        crypto: yield* Crypto.Crypto,
        writeQueue: yield* makeWriteQueue,
        fileProblems: yield* makeFileProblems(yield* Status),
        commitSettings: yield* CommitSettings,
        web: yield* Web,
        references: yield* References,
      };

      const favorites = yield* FavoriteModels;
      const tuiMemory = yield* TuiMemory;
      const files = yield* FileTags;
      const stashes = yield* Stashes;
      const connections = yield* Connections;

      const runners = yield* RcMap.make({ lookup: (key: RunnerKey) => openRunner(services, key) });

      const open = Effect.fn("Agent.open")(function* (
        session: Option.Option<SessionId | Extract<SessionState, { kind: "draft" }>>,
        directory: string,
      ) {
        const target = Option.isSome(session)
          ? session.value
          : {
              kind: "draft" as const,
              session: yield* services.sessions.allocate(directory),
              references: [],
            };

        return yield* RcMap.get(runners, new RunnerKey(target));
      });

      return Agent.of({
        open,
        sessions: services.sessions.list,
        models: services.models.available,
        favoriteModels: favorites.read,
        toggleFavoriteModel: favorites.toggle,
        sidebarChoice: tuiMemory.sidebar,
        references: services.references,
        connections,
        stashes,
        files,
        saveSidebarChoice: tuiMemory.saveSidebar,
      });
    }),
  );
}

// Runner identity stays the same when a draft becomes a saved session.
class RunnerKey implements Equal.Equal {
  readonly id: SessionId;

  constructor(readonly target: SessionId | Extract<SessionState, { kind: "draft" }>) {
    this.id = Predicate.isString(target) ? target : target.session.id;
  }

  [Equal.symbol](other: Equal.Equal): boolean {
    return other instanceof RunnerKey && other.id === this.id;
  }

  [Hash.symbol](): number {
    return Hash.string(this.id);
  }
}

const openRunner = Effect.fn("openRunner")(function* (services: RunServices, key: RunnerKey) {
  if (!Predicate.isString(key.target)) {
    const draft = key.target;

    // A crash can follow commit before the supervisor learns that the draft was saved.
    const restored = yield* services.sessions.get(key.id).pipe(
      Effect.map((session): SessionState => ({ kind: "saved", session })),
      Effect.catchTag("SessionNotFound", () => Effect.succeed(draft)),
    );

    return yield* makeRunner(services, restored);
  }

  const session = yield* services.sessions.get(key.target);
  return yield* makeRunner(services, { kind: "saved", session });
});
