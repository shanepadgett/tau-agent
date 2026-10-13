/** Finds the user's own instruction files: the one in `~/.agents`, then the one in `~/.tau`. */

import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import { UserInstructions } from "../core/UserInstructions.ts";
import { TauHome } from "../database/TauHome.ts";

/** The `.agents` folder is shared with other agents, so it comes before Tau's own file. */
export const userInstructionsLayer = Layer.effect(
  UserInstructions,
  Effect.gen(function* () {
    const { directory } = yield* TauHome;

    return UserInstructions.of({
      files: [join(dirname(directory), ".agents", "AGENTS.md"), join(directory, "AGENTS.md")],
    });
  }),
);
