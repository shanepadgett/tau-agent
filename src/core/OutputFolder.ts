/** The root folder for full tool output. The host supplies it; tests use an isolated temp folder. */

import { Context } from "effect";

export class OutputFolder extends Context.Service<
  OutputFolder,
  {
    readonly directory: string;
  }
>()("tau/core/OutputFolder") {}
