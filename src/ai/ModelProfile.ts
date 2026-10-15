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

export type Abilities = typeof Abilities.Type;

/** One ladder of thinking levels for every model, lowest first. Each model offers some of them. */
const THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;

export const ThinkingLevel = Schema.Literals(THINKING_LEVELS);

export type ThinkingLevel = typeof ThinkingLevel.Type;

/**
 * How a model takes a thinking level. `effort` sends the provider's own word for each level it
 * offers; `budget` sends a number of thinking tokens; `toggle` only turns thinking on (as
 * `medium`) or off. `canTurnOff` says the request can turn thinking off, which offers `off`.
 */
export type Thinking =
  | {
      readonly kind: "effort";
      readonly values: Partial<Record<ThinkingLevel, string>>;
      readonly canTurnOff: boolean;
    }
  | { readonly kind: "budget"; readonly minTokens: number; readonly maxTokens: number | undefined }
  | { readonly kind: "toggle" };

const BUDGET_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "max"];
const TOGGLE_LEVELS: readonly ThinkingLevel[] = ["off", "medium"];

/** The levels a model offers, in ladder order. A model with no thinking, or no choice, offers none. */
export const thinkingLevels = (thinking: Thinking | undefined): readonly ThinkingLevel[] => {
  switch (thinking?.kind) {
    case undefined:
      return [];

    case "budget":
      return BUDGET_LEVELS;

    case "toggle":
      return TOGGLE_LEVELS;

    case "effort":
      return THINKING_LEVELS.filter(
        (level) => thinking.values[level] !== undefined || (level === "off" && thinking.canTurnOff),
      );
  }
};

/**
 * The offered level nearest to `wanted`: the next one up, or else the next one down. Undefined when
 * the model offers no levels.
 */
export const clampThinking = (
  offered: readonly ThinkingLevel[],
  wanted: ThinkingLevel,
): ThinkingLevel | undefined => {
  const rank = THINKING_LEVELS.indexOf(wanted);
  const above = offered.find((level) => THINKING_LEVELS.indexOf(level) >= rank);
  return above ?? offered.at(-1);
};

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
  readonly thinking: Thinking | undefined;
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
    thinking: undefined,
  });
};

/** The token counts of one model call, as the provider reports them. Input includes cached tokens. */
export type CallTokens = {
  readonly input?: number | undefined;
  readonly output?: number | undefined;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
};

const PER_MILLION = 1_000_000;

/** What one call cost in US dollars, or undefined when the model has no price. */
export const callCost = (profile: ModelProfile, tokens: CallTokens): number | undefined => {
  const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = tokens;
  const long = profile.longContextPrice;
  const price = long !== undefined && input > long.aboveTokens ? long.price : profile.price;
  if (price === undefined) return undefined;

  const uncached = input - cacheRead - cacheWrite;

  const dollars =
    uncached * price.input +
    cacheRead * price.cacheRead +
    cacheWrite * price.cacheWrite +
    output * price.output;

  return dollars / PER_MILLION;
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
