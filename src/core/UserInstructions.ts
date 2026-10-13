/** What the user set up for every session: their agents files, instruction files and skills. */

import { Context } from "effect";

export class UserInstructions extends Context.Service<
  UserInstructions,
  {
    /** False turns off every agents file, the user's and the project's. */
    readonly agentsFiles: boolean;
    /** Paths of the user's agents files, most shared first. A file that does not exist is skipped. */
    readonly files: readonly string[];
    /** Folders of the user's instruction files, most shared first. */
    readonly instructionFolders: readonly string[];
    /** Folders of the user's skills, most shared first. */
    readonly skillFolders: readonly string[];
  }
>()("tau/core/UserInstructions") {}
