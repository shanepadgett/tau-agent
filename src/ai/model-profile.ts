/**
 * Defines the data that Tau keeps about each model: protocol, limits, prices and features. Applies
 * the user's settings to this data.
 */

import { Option, Schema, Struct } from "effect";

export const Protocol = Schema.Literals([
  "anthropic",
  "openaiResponses",
  "openaiChat",
  "openrouter",
]);

export type Protocol = typeof Protocol.Type;

/** US dollars per million tokens. */
const Price = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
});

export type Price = typeof Price.Type;

const Abilities = Schema.Struct({
  tools: Schema.Boolean,
  structuredOutput: Schema.Boolean,
  reasoning: Schema.Boolean,
  images: Schema.Boolean,
});

type Abilities = typeof Abilities.Type;

export type ModelProfile = {
  readonly id: string;
  readonly name: string;
  readonly protocol: Protocol;
  readonly contextTokens: number;
  readonly outputTokens: number;
  readonly price: Price | undefined;
  /** When the context is larger than `aboveTokens`, all tokens in the request cost `price`. */
  readonly longContextPrice: { readonly aboveTokens: number; readonly price: Price } | undefined;
  readonly supports: Abilities;
};

export type DecisionProfile = {
  readonly id: string;
  readonly name: string;
  readonly contextTokens: number;
};

/** A model as the user writes it in settings. It changes a known model, or adds a new model. */
export const ModelSettings = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  protocol: Schema.optionalKey(Protocol),
  contextTokens: Schema.optionalKey(Schema.Number),
  outputTokens: Schema.optionalKey(Schema.Number),
  price: Schema.optionalKey(Price),
  supports: Schema.optionalKey(Abilities.mapFields(Struct.map(Schema.optionalKey))),
});

export type ModelSettings = typeof ModelSettings.Type;

export const DecisionSettings = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  contextTokens: Schema.optionalKey(Schema.Number),
});

export type DecisionSettings = typeof DecisionSettings.Type;

/**
 * The features of a model that only the user's settings define, if the settings do not give other
 * values.
 */
const SETTINGS_ONLY_ABILITIES: Abilities = {
  tools: true,
  structuredOutput: false,
  reasoning: false,
  images: false,
};

/**
 * Applies the user's settings to the catalog data. If the catalog does not know the model, the
 * settings must give its context and output limits. If they do not, the result is none.
 */
export const applyModelSettings = (
  known: Option.Option<ModelProfile>,
  settings: ModelSettings | undefined,
  fallback: { readonly id: string; readonly protocol: Protocol },
): Option.Option<ModelProfile> => {
  if (settings === undefined) return known;

  if (Option.isSome(known)) {
    return Option.some({
      ...known.value,
      ...withoutSupports(settings),
      supports: { ...known.value.supports, ...settings.supports },
    });
  }

  const { contextTokens, outputTokens } = settings;
  if (contextTokens === undefined || outputTokens === undefined) return Option.none();

  return Option.some({
    id: fallback.id,
    name: settings.name ?? fallback.id,
    protocol: settings.protocol ?? fallback.protocol,
    contextTokens,
    outputTokens,
    price: settings.price,
    longContextPrice: undefined,
    supports: { ...SETTINGS_ONLY_ABILITIES, ...settings.supports },
  });
};

export const applyDecisionSettings = (
  known: Option.Option<DecisionProfile>,
  settings: DecisionSettings | undefined,
  id: string,
): Option.Option<DecisionProfile> => {
  if (settings === undefined) return known;
  if (Option.isSome(known)) return Option.some({ ...known.value, ...settings });

  const { contextTokens } = settings;
  if (contextTokens === undefined) return Option.none();
  return Option.some({ id, name: settings.name ?? id, contextTokens });
};

const withoutSupports = ({ supports: _supports, ...rest }: ModelSettings) => rest;
