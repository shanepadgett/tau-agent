/** Builds the agent with the services it needs, and opens a session on it for print mode or the TUI. */

import { Effect, Layer, Option } from "effect";
import { Catalog } from "../../ai/Catalog.ts";
import { Models } from "../../ai/Models.ts";
import { Agent } from "../../core/Agent.ts";
import { ContextMethod } from "../../core/ContextMethod.ts";
import { userInstructionsLayer } from "../../host/UserInstructions.ts";
import { SessionId } from "../../session/Entry.ts";
import { Sessions } from "../../session/Sessions.ts";
import { showFailure } from "./failure.ts";

/** The agent with everything it needs: the models of the catalog, and the session store. */
export const agentLayer = Agent.layer.pipe(
  Layer.provideMerge(ContextMethod.layer),
  Layer.provideMerge(Models.layer),
  Layer.provideMerge(Catalog.layer),
  Layer.provide(Sessions.layer),
  Layer.provide(userInstructionsLayer),
);

/**
 * Opens the session with the ID of `--session`, or a new one in the current folder. Also refreshes
 * a stale model catalog in the background while the session stays open.
 */
export const openSession = Effect.fn("openSession")(function* (flag: Option.Option<string>) {
  yield* Effect.forkScoped((yield* Catalog).refreshIfStale);
  const id = Option.map(flag, (text) => SessionId.make(text));

  return yield* (yield* Agent)
    .open(id, process.cwd())
    .pipe(
      Effect.catchTag("SessionNotFound", (error) =>
        showFailure({ message: `There is no session ${error.session}.` }),
      ),
    );
});
