/**
 * Gets the list of models that a ChatGPT plan allows. This list and its context limits are
 * different from the API list.
 */

import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { LiveList } from "../../Providers.ts";

export const LiveModel = Schema.Struct({
  id: Schema.String,
  contextTokens: Schema.optional(Schema.Number),
});

export type LiveModel = typeof LiveModel.Type;

// The backend hides models that are newer than the client version in the request.
// All recent Codex versions see all models.
const CODEX_CLIENT_VERSION = "0.200.0";

const PlanModels = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      context_window: Schema.optional(Schema.Number),
      /** `hide` marks models that the Codex CLI keeps for its own use, for example reviews. */
      visibility: Schema.String,
    }),
  ),
});

/**
 * Reads the list at `apiUrl` through `client`. The client must already sign requests for the provider.
 */
export const fetchLiveModels = Effect.fn("fetchLiveModels")(function* (
  apiUrl: string,
  list: LiveList,
  client: HttpClient.HttpClient,
) {
  // Both lists have the same shape: the public API answers a ChatGPT plan token as the Codex backend does.
  // Only the Codex backend asks for the client version.
  const urlParams = list === "codexModels" ? { client_version: CODEX_CLIENT_VERSION } : {};

  const { models } = yield* client
    .get(`${apiUrl}/models`, { urlParams })
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(PlanModels)),
    );

  return models.flatMap((model): ReadonlyArray<LiveModel> => {
    if (model.visibility !== "list") return [];
    const contextTokens = model.context_window;

    return [contextTokens === undefined ? { id: model.slug } : { id: model.slug, contextTokens }];
  });
});
