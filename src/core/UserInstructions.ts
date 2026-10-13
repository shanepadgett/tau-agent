/** The user's own instruction files, which apply to every session. */

import { Context } from "effect";

export class UserInstructions extends Context.Service<
  UserInstructions,
  {
    /** Paths of the files, most shared first. A file that does not exist is skipped. */
    readonly files: readonly string[];
  }
>()("tau/core/UserInstructions") {}
