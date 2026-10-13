/**
 * Reads model data from models.dev. Tau decodes each model separately, so one bad entry does not
 * stop the others.
 */

import { Option, Schema } from "effect";
import type { ModelProfile, Price, Protocol } from "./model-profile.ts";

/** models.dev entries by provider, then by model ID. */
export const ModelsDevCatalog = Schema.Record(
  Schema.String,
  Schema.Struct({ models: Schema.Record(Schema.String, Schema.Json) }),
);

export type ModelsDevCatalog = typeof ModelsDevCatalog.Type;

const ModelsDevCost = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cache_read: Schema.optional(Schema.Number),
  cache_write: Schema.optional(Schema.Number),
});

const ModelsDevModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  reasoning: Schema.Boolean,
  tool_call: Schema.Boolean,
  structured_output: Schema.optional(Schema.Boolean),
  modalities: Schema.optional(Schema.Struct({ input: Schema.Array(Schema.String) })),
  limit: Schema.Struct({ context: Schema.Number, output: Schema.Number }),
  cost: Schema.optional(
    Schema.Struct({
      ...ModelsDevCost.fields,
      tiers: Schema.optional(
        Schema.Array(
          Schema.Struct({
            ...ModelsDevCost.fields,
            tier: Schema.Struct({ type: Schema.String, size: Schema.Number }),
          }),
        ),
      ),
    }),
  ),
  /** Set when the model uses a protocol that is different from the default of its provider. */
  provider: Schema.optional(Schema.Struct({ npm: Schema.optional(Schema.String) })),
});

type ModelsDevModel = typeof ModelsDevModel.Type;

// models.dev gives the AI SDK package for each model. Each package uses one protocol.
const PROTOCOL_BY_PACKAGE: Readonly<Record<string, Protocol>> = {
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/openai": "openaiResponses",
  "@ai-sdk/openai-compatible": "openaiChat",
  "@openrouter/ai-sdk-provider": "openrouter",
};

const decodeModel = Schema.decodeUnknownOption(ModelsDevModel);

/**
 * Gives the profile of `modelId` from `provider`. The protocol is `routeProtocol`, unless the entry
 * gives a different one. Returns none if the entry is missing or bad, or if Tau cannot use its
 * protocol.
 */
export const modelsDevProfile = (
  catalog: ModelsDevCatalog,
  ref: { readonly provider: string; readonly modelId: string },
  routeProtocol: Protocol,
): Option.Option<ModelProfile> => {
  const entry = decodeModel(catalog[ref.provider]?.models[ref.modelId]);
  if (Option.isNone(entry)) return Option.none();

  const model = entry.value;
  const packageName = model.provider?.npm;
  const protocol = packageName === undefined ? routeProtocol : PROTOCOL_BY_PACKAGE[packageName];
  if (protocol === undefined) return Option.none();

  return Option.some({
    id: ref.modelId,
    name: model.name,
    protocol,
    contextTokens: model.limit.context,
    outputTokens: model.limit.output,
    price: model.cost === undefined ? undefined : toPrice(model.cost),
    longContextPrice: longContextPrice(model),
    supports: {
      tools: model.tool_call,
      structuredOutput: model.structured_output ?? false,
      reasoning: model.reasoning,
      images: model.modalities?.input.includes("image") ?? false,
    },
  });
};

/** Keeps only the providers that the routes of Tau read, so the cache stays small. */
export const keepProviders = (catalog: ModelsDevCatalog, providers: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries(catalog).filter(([provider]) => providers.includes(provider)));

const toPrice = (cost: typeof ModelsDevCost.Type): Price => ({
  input: cost.input,
  output: cost.output,
  cacheRead: cost.cache_read ?? 0,
  cacheWrite: cost.cache_write ?? 0,
});

const longContextPrice = (model: ModelsDevModel) => {
  const tier = model.cost?.tiers?.find((candidate) => candidate.tier.type === "context");
  return tier === undefined ? undefined : { aboveTokens: tier.tier.size, price: toPrice(tier) };
};
