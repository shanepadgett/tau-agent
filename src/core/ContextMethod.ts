/** Selects what the model sees and starts session-scoped background work. Replace this service to change compaction. */

import { Context, Effect, Layer, Option, type PubSub, type Scope } from "effect";
import type { ModelRef, UnknownModel, UnknownRoute } from "../ai/Catalog.ts";
import { contextView } from "../session/ContextView.ts";
import type { RunningProcess, SessionId } from "../session/Entry.ts";
import type { AgentEvent } from "./Client.ts";
import { ContextSettings } from "./ContextSettings.ts";
import { makeNotesMethod } from "./internal/context/notes/method.ts";
import type { RunMethod } from "./internal/context/run-method.ts";
import { needsReply } from "./internal/loop/tool-history.ts";

const wholeHistory = {
  forRun: (): Effect.Effect<RunMethod> =>
    Effect.succeed({
      view: (soul, entries) => Effect.succeed(contextView(soul, entries)),
      tools: [],
      nudge: () => Option.none(),
      operations: [],
      shouldReply: needsReply,
    }),
  background: () => Effect.void,
};

export class ContextMethod extends Context.Service<
  ContextMethod,
  {
    readonly forRun: (
      session: SessionId,
      model: ModelRef,
      /** The commands the agent has running, which a checkpoint lists. */
      running: Effect.Effect<readonly RunningProcess[]>,
    ) => Effect.Effect<RunMethod, UnknownModel | UnknownRoute>;
    readonly background: (
      session: SessionId,
      subscribe: Effect.Effect<PubSub.Subscription<AgentEvent>, never, Scope.Scope>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("tau/core/ContextMethod") {
  static readonly wholeHistory = Layer.succeed(ContextMethod, wholeHistory);

  static readonly layer = Layer.effect(
    ContextMethod,
    Effect.gen(function* () {
      const settings = yield* ContextSettings;
      if (settings.method === "off") return ContextMethod.of(wholeHistory);
      return ContextMethod.of(yield* makeNotesMethod());
    }),
  );
}
