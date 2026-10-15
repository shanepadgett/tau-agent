/** Finds the limits, prices and features of a model on a provider. It uses models.dev data, the plan model lists and the user's settings. */

import { Array, Context, DateTime, Duration, Effect, Layer, Option, Ref, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import bundledSnapshot from "./catalog-snapshot.json" with { type: "json" };
import { CredentialStore } from "./Credential.ts";
import { fetchLiveModels, LiveModel } from "./internal/catalog/live-models.ts";
import {
  applyDecisionSettings,
  applyModelSettings,
  type DecisionProfile,
  type ModelProfile,
  type ThinkingLevel,
  thinkingLevels,
} from "./ModelProfile.ts";
import {
  keepProviders,
  ModelsDevCatalog,
  modelsDevProfile,
} from "./internal/catalog/models-dev.ts";
import { credentialSigner, signRequests } from "./internal/signing/provider-auth.ts";
import {
  type LiveList,
  type Provider,
  ProviderId,
  type ProviderSettings,
  ProviderTable,
} from "./Providers.ts";

const REFRESH_INTERVAL = Duration.days(1);

/**
 * The catalog data in the cache file `~/.tau/catalog.json` and in the binary. The copy in the
 * binary has no plan model lists.
 */
export const CatalogData = Schema.Struct({
  fetchedAt: Schema.DateTimeUtcFromMillis,
  claudeCodeVersion: Schema.String,
  modelsDev: ModelsDevCatalog,
  liveModels: Schema.optional(Schema.Record(Schema.String, Schema.Array(LiveModel))),
});

export type CatalogData = typeof CatalogData.Type;

export type ModelRef = { readonly provider: ProviderId; readonly model: string };

/** A model the user can choose, with the name to show. */
export type ListedModel = {
  readonly ref: ModelRef;
  readonly name: string;
  readonly contextTokens: number;
  /** The thinking levels the model offers, lowest first; empty when it has no choice. */
  readonly thinking: readonly ThinkingLevel[];
  /** Whether the model can see pictures. */
  readonly images: boolean;
};

/** The models of one provider that Tau can use. */
type ProviderModels = { readonly provider: Provider; readonly models: readonly ListedModel[] };

/**
 * Reads `provider/model`. The provider ends at the first slash, so a model name may hold slashes, as in
 * `openrouter/anthropic/claude-haiku-5.5`.
 */
export const parseModelRef = (text: string): Option.Option<ModelRef> => {
  const slash = text.indexOf("/");
  const isRef = slash > 0 && slash < text.length - 1;
  if (!isRef) return Option.none();

  return Option.some({
    provider: ProviderId.make(text.slice(0, slash)),
    model: text.slice(slash + 1),
  });
};

/** Writes `provider/model`, the text that `parseModelRef` reads. */
export const formatModelRef = (ref: ModelRef) => `${ref.provider}/${ref.model}`;

/**
 * The addresses that the daily refresh reads for models.dev data and the latest Claude Code
 * release. Tests use a fake server.
 */
type CatalogSources = { readonly modelsDevUrl: string; readonly claudeCodeUrl: string };

export const CatalogSources = Context.Reference<CatalogSources>("tau/ai/CatalogSources", {
  defaultValue: () => ({
    modelsDevUrl: "https://models.dev/api.json",
    claudeCodeUrl: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
  }),
});

export class UnknownProvider extends Schema.TaggedError<UnknownProvider>()("UnknownProvider", {
  provider: ProviderId,
  message: Schema.String,
}) {}

export class UnknownModel extends Schema.TaggedError<UnknownModel>()("UnknownModel", {
  provider: ProviderId,
  model: Schema.String,
  message: Schema.String,
}) {}

export class NoDecisionApi extends Schema.TaggedError<NoDecisionApi>()("NoDecisionApi", {
  provider: ProviderId,
  message: Schema.String,
}) {}

export class CatalogCacheError extends Schema.TaggedError<CatalogCacheError>()(
  "CatalogCacheError",
  { path: Schema.String, cause: Schema.Defect() },
) {}

/**
 * The AI layer reads and writes the cached catalog through this service. The host layer keeps the
 * file in `~/.tau`.
 */
export class CatalogCache extends Context.Service<
  CatalogCache,
  {
    /**
     * None if there is no cache, or if Tau cannot read it. Then the catalog starts from the copy in
     * the binary.
     */
    readonly read: Effect.Effect<Option.Option<CatalogData>>;
    readonly write: (data: CatalogData) => Effect.Effect<void, CatalogCacheError>;
  }
>()("tau/ai/CatalogCache") {}

type ResolvedModel<Profile> = { readonly provider: Provider; readonly profile: Profile };

export class Catalog extends Context.Service<
  Catalog,
  {
    readonly model: (
      ref: ModelRef,
    ) => Effect.Effect<ResolvedModel<ModelProfile>, UnknownProvider | UnknownModel>;
    readonly decisionModel: (
      ref: ModelRef,
    ) => Effect.Effect<
      ResolvedModel<DecisionProfile>,
      UnknownProvider | UnknownModel | NoDecisionApi
    >;
    /** The models of each provider that can call tools: its plan list, or models.dev, and the settings. */
    readonly providerModels: Effect.Effect<readonly ProviderModels[]>;
    readonly claudeCodeVersion: Effect.Effect<string>;
    /**
     * Gets new catalog data if the data is more than one day old. If one part fails, that part
     * keeps its last value. Whatever the age, it also gets the model list of each signed-in plan
     * provider that has none yet.
     */
    readonly refreshIfStale: Effect.Effect<void>;
  }
>()("tau/ai/Catalog") {
  /** The catalog of the providers in the provider table. */
  static readonly layer = Layer.effect(
    Catalog,
    Effect.gen(function* () {
      const { providers, settings } = yield* ProviderTable;
      return yield* makeCatalog({ providers, settings, sources: yield* CatalogSources });
    }),
  );
}

type CatalogOptions = {
  readonly providers: ReadonlyArray<Provider>;
  readonly settings: ReadonlyMap<ProviderId, ProviderSettings>;
  readonly sources: CatalogSources;
};

// `mise run catalog` makes the snapshot. If it does not decode, that tool has a bug.
const bundled = Schema.decodeUnknownSync(CatalogData)(bundledSnapshot);

const makeCatalog = Effect.fn("makeCatalog")(function* (options: CatalogOptions) {
  const { providers, settings } = options;
  const cache = yield* CatalogCache;
  const context = yield* Effect.context<CatalogCache | CredentialStore | HttpClient.HttpClient>();
  const current = yield* Ref.make(newerOf(bundled, yield* cache.read));

  const findProvider = (id: ProviderId) => {
    const provider = providers.find((candidate) => candidate.id === id);
    if (provider !== undefined) return Effect.succeed(provider);

    return Effect.fail(
      new UnknownProvider({
        provider: id,
        message: `No provider is named ${id}. Check the provider part of the model name.`,
      }),
    );
  };

  const model = Effect.fn("Catalog.model")(function* (ref: ModelRef) {
    const provider = yield* findProvider(ref.provider);
    const catalogData = yield* Ref.get(current);
    const profile = chatProfile(provider, ref.model, catalogData, settings.get(provider.id));
    if (Option.isNone(profile)) return yield* unknownModel(provider, ref.model, "models");

    // Tau works only through tools, so it hides models that cannot call them.
    if (!profile.value.supports.tools) {
      return yield* new UnknownModel({
        provider: provider.id,
        model: ref.model,
        message: `${ref.model} on ${provider.id} cannot call tools, so Tau cannot use it. If it can, set providers.${provider.id}.models.${ref.model}.supports.tools to true in ~/.tau/settings.json.`,
      });
    }

    return { provider, profile: profile.value };
  });

  const decisionModel = Effect.fn("Catalog.decisionModel")(function* (ref: ModelRef) {
    const provider = yield* findProvider(ref.provider);

    if (provider.decisions === undefined) {
      return yield* new NoDecisionApi({
        provider: provider.id,
        message: `${provider.id} has no decision API. Choose a decision model on openai or openrouter.`,
      });
    }

    const known = provider.decisions.models.find((candidate) => candidate.id === ref.model);
    const corrections = settings.get(provider.id)?.decisionModels[ref.model];
    const profile = applyDecisionSettings(Option.fromUndefinedOr(known), corrections, ref.model);
    if (Option.isNone(profile)) return yield* unknownModel(provider, ref.model, "decisionModels");
    return { provider, profile: profile.value };
  });

  const providerModels = Effect.map(Ref.get(current), (catalogData) =>
    providers.map((provider) => ({
      provider,
      models: listedModels(provider, catalogData, settings.get(provider.id)),
    })),
  );

  const claudeCodeVersion = Ref.get(current).pipe(
    Effect.map((catalogData) => catalogData.claudeCodeVersion),
  );

  const refreshIfStale = refreshCatalog(current, options).pipe(Effect.provideContext(context));

  return Catalog.of({ model, decisionModel, providerModels, claudeCodeVersion, refreshIfStale });
});

/**
 * Gets new catalog data if `current` is more than one day old, and caches it. A fresh catalog still
 * gets the plan lists that it lacks, so a new login or a failed fetch does not wait a day.
 */
const refreshCatalog = Effect.fn("refreshCatalog")(function* (
  current: Ref.Ref<CatalogData>,
  options: CatalogOptions,
) {
  const { providers } = options;
  const cache = yield* CatalogCache;
  const last = yield* Ref.get(current);
  const now = yield* DateTime.now;
  const isFresh = Duration.isLessThan(DateTime.distance(last.fetchedAt, now), REFRESH_INTERVAL);
  if (isFresh) return yield* refreshMissingLists(current, options);

  const [modelsDev, latestClaudeCode, liveModels] = yield* Effect.all(
    [
      fetchModelsDev(options.sources.modelsDevUrl, catalogProviders(providers)),
      fetchClaudeCodeVersion(options.sources.claudeCodeUrl),
      fetchPlanLists(providers, last.claudeCodeVersion),
    ],
    { concurrency: "unbounded" },
  );

  const next: CatalogData = {
    // If the models.dev request fails, the date does not change, so the next start tries again.
    fetchedAt: Option.isSome(modelsDev) ? now : last.fetchedAt,
    modelsDev: Option.getOrElse(modelsDev, () => last.modelsDev),
    claudeCodeVersion: Option.match(latestClaudeCode, {
      onNone: () => last.claudeCodeVersion,
      onSome: (latest) => laterVersion(latest, bundled.claudeCodeVersion),
    }),
    liveModels: { ...last.liveModels, ...liveModels },
  };

  yield* Ref.set(current, next);

  yield* cache
    .write(next)
    .pipe(Effect.catch((error) => Effect.logWarning("Could not cache the model catalog", error)));
});

/** Gets the plan lists that a fresh catalog lacks. A provider with no login has none and is skipped. */
const refreshMissingLists = Effect.fn("refreshMissingLists")(function* (
  current: Ref.Ref<CatalogData>,
  options: CatalogOptions,
) {
  const cache = yield* CatalogCache;
  const last = yield* Ref.get(current);

  const missing = options.providers.filter(
    (provider) => last.liveModels?.[provider.id] === undefined,
  );

  const liveModels = yield* fetchPlanLists(missing, last.claudeCodeVersion);
  if (Object.keys(liveModels).length === 0) return;

  const next: CatalogData = { ...last, liveModels: { ...last.liveModels, ...liveModels } };
  yield* Ref.set(current, next);

  yield* cache
    .write(next)
    .pipe(Effect.catch((error) => Effect.logWarning("Could not cache the model catalog", error)));
});

/** A plan provider lists only the models its plan allows; models from settings are added. */
const listedModels = (
  provider: Provider,
  catalogData: CatalogData,
  settings: ProviderSettings | undefined,
): readonly ListedModel[] => {
  const catalogProvider = provider.catalogProvider;
  const planList = catalogData.liveModels?.[provider.id];

  const providerModels =
    catalogProvider === undefined ? {} : catalogData.modelsDev[catalogProvider]?.models;

  const known = planList?.map((listed) => listed.id) ?? Object.keys(providerModels ?? {});
  const ids = new Set([...known, ...Object.keys(settings?.models ?? {})]);

  return [...ids].flatMap((id) => {
    const profile = chatProfile(provider, id, catalogData, settings);
    if (Option.isNone(profile) || !profile.value.supports.tools) return [];
    const { name, contextTokens, thinking, supports } = profile.value;
    const ref = { provider: provider.id, model: id };

    return [
      { ref, name, contextTokens, thinking: thinkingLevels(thinking), images: supports.images },
    ];
  });
};

const chatProfile = (
  provider: Provider,
  modelId: string,
  catalogData: CatalogData,
  settings: ProviderSettings | undefined,
) => {
  const catalogProvider = provider.catalogProvider;

  const known =
    catalogProvider === undefined
      ? Option.none()
      : modelsDevProfile(
          catalogData.modelsDev,
          { provider: catalogProvider, modelId },
          provider.protocol,
        );

  const allowed = planAllows(known, catalogData.liveModels?.[provider.id], modelId);

  return applyModelSettings(allowed, settings?.models[modelId], {
    id: modelId,
    protocol: provider.protocol,
  });
};

/**
 * The model list of a plan provider removes the models that the plan does not allow. Its context limit
 * replaces the API limit.
 */
const planAllows = (
  known: Option.Option<ModelProfile>,
  planList: ReadonlyArray<LiveModel> | undefined,
  modelId: string,
) => {
  if (planList === undefined) return known;
  const listed = planList.find((candidate) => candidate.id === modelId);
  if (listed === undefined) return Option.none();

  const { contextTokens } = listed;
  if (contextTokens === undefined) return known;
  return Option.map(known, (profile) => ({ ...profile, contextTokens }));
};

/**
 * Uses the cache if it is newer than the copy in the binary. An older version of Tau can write an
 * older cache.
 */
const newerOf = (snapshot: CatalogData, cached: Option.Option<CatalogData>): CatalogData => {
  if (Option.isNone(cached)) return snapshot;
  const { value } = cached;
  const claudeCodeVersion = laterVersion(value.claudeCodeVersion, snapshot.claudeCodeVersion);

  if (DateTime.isGreaterThan(value.fetchedAt, snapshot.fetchedAt))
    return { ...value, claudeCodeVersion };

  return { ...snapshot, claudeCodeVersion, liveModels: value.liveModels };
};

const laterVersion = (version: string, floor: string) =>
  Bun.semver.order(version, floor) >= 0 ? version : floor;

const catalogProviders = (providers: ReadonlyArray<Provider>) =>
  providers.flatMap((provider) =>
    provider.catalogProvider === undefined ? [] : [provider.catalogProvider],
  );

/**
 * Runs one part of the refresh. If it fails, it logs a warning and returns none, so the caller
 * keeps the last value.
 */
const orKeepLast = <A, E, R>(part: string, step: Effect.Effect<A, E, R>) =>
  step.pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      Effect.logWarning(`Could not refresh ${part}`, error).pipe(Effect.as(Option.none<A>())),
    ),
  );

const fetchModelsDev = (url: string, providers: ReadonlyArray<string>) =>
  orKeepLast(
    "the model catalog from models.dev",
    HttpClient.get(url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ModelsDevCatalog)),
      Effect.map((catalog) => keepProviders(catalog, providers)),
    ),
  );

const NpmRelease = Schema.Struct({ version: Schema.String });

const fetchClaudeCodeVersion = (url: string) =>
  orKeepLast(
    "the Claude Code version from npm",
    HttpClient.get(url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(NpmRelease)),
      Effect.map((release) => release.version),
    ),
  );

/**
 * Gets the model list of each plan provider. It skips a provider that has no login, because that provider
 * has no list.
 */
const fetchPlanLists = Effect.fn("fetchPlanLists")(function* (
  providers: ReadonlyArray<Provider>,
  claudeCodeVersion: string,
) {
  const lists = yield* Effect.forEach(
    providers,
    (provider) => {
      const list = provider.liveList;
      if (list === undefined) return Effect.succeed(Option.none());
      return fetchPlanList(provider, list, claudeCodeVersion);
    },
    { concurrency: "unbounded" },
  );

  return Object.fromEntries(Array.getSomes(lists));
});

const fetchPlanList = Effect.fn("fetchPlanList")(function* (
  provider: Provider,
  list: LiveList,
  claudeCodeVersion: string,
) {
  const signing = { protocol: provider.protocol, claudeCodeVersion, conversationId: undefined };
  const hasLogin = Option.isSome(yield* Effect.option(credentialSigner(provider, signing)));
  if (!hasLogin) return Option.none();

  const client = (yield* signRequests(provider, signing))(yield* HttpClient.HttpClient);

  const models = yield* orKeepLast(
    `the ${provider.id} model list`,
    fetchLiveModels(provider.apiUrl, list, client),
  );

  return Option.map(models, (listed) => [provider.id, listed] as const);
});

const unknownModel = (provider: Provider, model: string, section: "models" | "decisionModels") =>
  Effect.fail(
    new UnknownModel({
      provider: provider.id,
      model,
      message: `${provider.id} has no model ${model} that Tau knows. Check the name, or add it under providers.${provider.id}.${section} in ~/.tau/settings.json with its limits.`,
    }),
  );
