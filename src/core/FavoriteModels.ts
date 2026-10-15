/** The models the user keeps at the top of `/model`. The CLI gives the file in Tau's home folder; a test gives a temporary one. */

import { Context, type Effect, Schema } from "effect";
import type { ModelRef } from "../ai/Catalog.ts";

export class FavoriteModelsError extends Schema.TaggedError<FavoriteModelsError>()(
  "FavoriteModelsError",
  { path: Schema.String, cause: Schema.Defect() },
) {}

export class FavoriteModels extends Context.Service<
  FavoriteModels,
  {
    /** Empty if there are no favorites, or if Tau cannot read them. */
    readonly read: Effect.Effect<readonly ModelRef[]>;
    /**
     * Adds `ref` if it is not a favorite, and removes it if it is. It reads the saved list first,
     * so a change from another Tau process stays. Gives the new list.
     */
    readonly toggle: (ref: ModelRef) => Effect.Effect<readonly ModelRef[], FavoriteModelsError>;
  }
>()("tau/core/FavoriteModels") {}
