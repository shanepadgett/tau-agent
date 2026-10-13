/** Finds the limits, prices and features of a model on a route. It uses models.dev data, the plan model lists and the user's settings. */

import { Array, Context, DateTime, Duration, Effect, Layer, Option, Ref, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import bundledSnapshot from "./catalog-snapshot.json" with { type: "json" };
import { CredentialStore } from "./credential.ts";
import { fetchLiveModels, LiveModel } from "./live-models.ts";
import {
  applyDecisionSettings,
  applyModelSettings,
  type DecisionProfile,
  type DecisionSettings,
  type ModelProfile,
  type ModelSettings,
} from "./model-profile.ts";
import { keepProviders, ModelsDevCatalog, modelsDevProfile } from "./models-dev.ts";
import { credentialSigner, signRequests } from "./route-auth.ts";
import { type LiveList, type Route, RouteId } from "./routes.ts";

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

export type ModelRef = { readonly route: RouteId; readonly model: string };

/**
 * Reads `route/model`. The route ends at the first slash, so a model name may hold slashes, as in
 * `openrouter/anthropic/claude-haiku-5.5`.
 */
export const parseModelRef = (text: string): Option.Option<ModelRef> => {
  const slash = text.indexOf("/");
  const isRef = slash > 0 && slash < text.length - 1;
  if (!isRef) return Option.none();
  return Option.some({ route: RouteId.make(text.slice(0, slash)), model: text.slice(slash + 1) });
};

/** The changes and additions that the user's settings make to the models of one route. */
export type RouteSettings = {
  readonly models: Readonly<Record<string, ModelSettings>>;
  readonly decisionModels: Readonly<Record<string, DecisionSettings>>;
};

/**
 * The addresses that the daily refresh reads for models.dev data and the latest Claude Code
 * release. Tests use a fake server.
 */
export type CatalogSources = { readonly modelsDevUrl: string; readonly claudeCodeUrl: string };

export const publicCatalogSources: CatalogSources = {
  modelsDevUrl: "https://models.dev/api.json",
  claudeCodeUrl: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
};

export class UnknownRoute extends Schema.TaggedError<UnknownRoute>()("UnknownRoute", {
  route: RouteId,
  message: Schema.String,
}) {}

export class UnknownModel extends Schema.TaggedError<UnknownModel>()("UnknownModel", {
  route: RouteId,
  model: Schema.String,
  message: Schema.String,
}) {}

export class NoDecisionApi extends Schema.TaggedError<NoDecisionApi>()("NoDecisionApi", {
  route: RouteId,
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

type RoutedModel<Profile> = { readonly route: Route; readonly profile: Profile };

export class Catalog extends Context.Service<
  Catalog,
  {
    readonly model: (
      ref: ModelRef,
    ) => Effect.Effect<RoutedModel<ModelProfile>, UnknownRoute | UnknownModel>;
    readonly decisionModel: (
      ref: ModelRef,
    ) => Effect.Effect<RoutedModel<DecisionProfile>, UnknownRoute | UnknownModel | NoDecisionApi>;
    readonly claudeCodeVersion: Effect.Effect<string>;
    /**
     * Gets new catalog data if the data is more than one day old. If one part fails, that part
     * keeps its last value.
     */
    readonly refreshIfStale: Effect.Effect<void>;
  }
>()("tau/ai/Catalog") {}

export type CatalogOptions = {
  readonly routes: ReadonlyArray<Route>;
  readonly settings: ReadonlyMap<RouteId, RouteSettings>;
  readonly sources: CatalogSources;
};

export const catalogLayer = (options: CatalogOptions) =>
  Layer.effect(Catalog, makeCatalog(options));

// `mise run catalog` makes the snapshot. If it does not decode, that tool has a bug.
const bundled = Schema.decodeUnknownSync(CatalogData)(bundledSnapshot);

const makeCatalog = Effect.fn("makeCatalog")(function* (options: CatalogOptions) {
  const { routes, settings } = options;
  const cache = yield* CatalogCache;
  const context = yield* Effect.context<CatalogCache | CredentialStore | HttpClient.HttpClient>();
  const current = yield* Ref.make(newerOf(bundled, yield* cache.read));

  const findRoute = (id: RouteId) => {
    const route = routes.find((candidate) => candidate.id === id);
    if (route !== undefined) return Effect.succeed(route);

    return Effect.fail(
      new UnknownRoute({
        route: id,
        message: `No route is named ${id}. Check the provider part of the model name.`,
      }),
    );
  };

  const model = Effect.fn("Catalog.model")(function* (ref: ModelRef) {
    const route = yield* findRoute(ref.route);
    const catalogData = yield* Ref.get(current);
    const profile = chatProfile(route, ref.model, catalogData, settings.get(route.id));
    if (Option.isNone(profile)) return yield* unknownModel(route, ref.model, "models");

    // Tau works only through tools, so it hides models that cannot call them.
    if (!profile.value.supports.tools) {
      return yield* new UnknownModel({
        route: route.id,
        model: ref.model,
        message: `${ref.model} on ${route.id} cannot call tools, so Tau cannot use it. If it can, set routes.${route.id}.models.${ref.model}.supports.tools to true in ~/.tau/settings.json.`,
      });
    }

    return { route, profile: profile.value };
  });

  const decisionModel = Effect.fn("Catalog.decisionModel")(function* (ref: ModelRef) {
    const route = yield* findRoute(ref.route);

    if (route.decisions === undefined) {
      return yield* new NoDecisionApi({
        route: route.id,
        message: `${route.id} has no decision API. Choose a decision model on openai or openrouter.`,
      });
    }

    const known = route.decisions.models.find((candidate) => candidate.id === ref.model);
    const corrections = settings.get(route.id)?.decisionModels[ref.model];
    const profile = applyDecisionSettings(Option.fromUndefinedOr(known), corrections, ref.model);
    if (Option.isNone(profile)) return yield* unknownModel(route, ref.model, "decisionModels");
    return { route, profile: profile.value };
  });

  const claudeCodeVersion = Ref.get(current).pipe(
    Effect.map((catalogData) => catalogData.claudeCodeVersion),
  );

  const refreshIfStale = refreshCatalog(current, options).pipe(Effect.provideContext(context));

  return Catalog.of({ model, decisionModel, claudeCodeVersion, refreshIfStale });
});

/** Gets new catalog data if `current` is more than one day old, and caches it. */
const refreshCatalog = Effect.fn("refreshCatalog")(function* (
  current: Ref.Ref<CatalogData>,
  options: CatalogOptions,
) {
  const { routes } = options;
  const cache = yield* CatalogCache;
  const last = yield* Ref.get(current);
  const now = yield* DateTime.now;
  const isFresh = Duration.isLessThan(DateTime.distance(last.fetchedAt, now), REFRESH_INTERVAL);
  if (isFresh) return;

  const [modelsDev, latestClaudeCode, liveModels] = yield* Effect.all(
    [
      fetchModelsDev(options.sources.modelsDevUrl, catalogProviders(routes)),
      fetchClaudeCodeVersion(options.sources.claudeCodeUrl),
      fetchPlanLists(routes, last.claudeCodeVersion),
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

const chatProfile = (
  route: Route,
  modelId: string,
  catalogData: CatalogData,
  settings: RouteSettings | undefined,
) => {
  const provider = route.catalogProvider;

  const known =
    provider === undefined
      ? Option.none()
      : modelsDevProfile(catalogData.modelsDev, { provider, modelId }, route.protocol);

  const allowed = planAllows(known, catalogData.liveModels?.[route.id], modelId);

  return applyModelSettings(allowed, settings?.models[modelId], {
    id: modelId,
    protocol: route.protocol,
  });
};

/**
 * The model list of a plan route removes the models that the plan does not allow. Its context limit
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

const catalogProviders = (routes: ReadonlyArray<Route>) =>
  routes.flatMap((route) => (route.catalogProvider === undefined ? [] : [route.catalogProvider]));

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
 * Gets the model list of each plan route. It skips a route that has no login, because that route
 * has no list.
 */
const fetchPlanLists = Effect.fn("fetchPlanLists")(function* (
  routes: ReadonlyArray<Route>,
  claudeCodeVersion: string,
) {
  const lists = yield* Effect.forEach(
    routes,
    (route) => {
      const list = route.liveList;
      if (list === undefined) return Effect.succeed(Option.none());
      return fetchPlanList(route, list, claudeCodeVersion);
    },
    { concurrency: "unbounded" },
  );

  return Object.fromEntries(Array.getSomes(lists));
});

const fetchPlanList = Effect.fn("fetchPlanList")(function* (
  route: Route,
  list: LiveList,
  claudeCodeVersion: string,
) {
  const signing = { protocol: route.protocol, claudeCodeVersion, conversationId: undefined };
  const hasLogin = Option.isSome(yield* Effect.option(credentialSigner(route, signing)));
  if (!hasLogin) return Option.none();

  const client = (yield* signRequests(route, signing))(yield* HttpClient.HttpClient);

  const models = yield* orKeepLast(
    `the ${route.id} model list`,
    fetchLiveModels(route.apiUrl, list, client),
  );

  return Option.map(models, (listed) => [route.id, listed] as const);
});

const unknownModel = (route: Route, model: string, section: "models" | "decisionModels") =>
  Effect.fail(
    new UnknownModel({
      route: route.id,
      model,
      message: `${route.id} has no model ${model} that Tau knows. Check the name, or add it under routes.${route.id}.${section} in ~/.tau/settings.json with its limits.`,
    }),
  );
