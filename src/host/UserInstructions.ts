/** Finds what the user set up in `~/.agents` and `~/.tau`, and whether agents files are on. */

import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import { UserInstructions } from "../core/UserInstructions.ts";
import { TauHome } from "../database/TauHome.ts";
import { Settings } from "./Settings.ts";

/** The `.agents` folder is shared with other agents, so it comes before Tau's own folder. */
export const userInstructionsLayer = Layer.effect(
  UserInstructions,
  Effect.gen(function* () {
    const { directory } = yield* TauHome;
    const { agentsFiles } = yield* Settings;
    const agents = join(dirname(directory), ".agents");

    return UserInstructions.of({
      agentsFiles,
      files: [join(agents, "AGENTS.md"), join(directory, "AGENTS.md")],
      instructionFolders: [join(directory, "instructions")],
      skillFolders: [join(agents, "skills"), join(directory, "skills")],
    });
  }),
);
