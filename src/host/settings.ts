/** Reads the user's settings from `~/.tau/settings.json`. The file can contain comments. */

import { join } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import type { RouteSettings } from "../ai/catalog.ts";
import { ProviderId } from "../ai/credential.ts";
import { DecisionSettings, ModelSettings, Protocol } from "../ai/model-profile.ts";
import { builtInRoutes, type Route, RouteId } from "../ai/routes.ts";

const RouteEntry = Schema.Struct({
  protocol: Schema.optional(Protocol),
  apiUrl: Schema.optional(Schema.String),
  /** The environment variable that holds the key. Without it, the route sends no key. */
  apiKeyEnv: Schema.optional(Schema.String),
  models: Schema.optional(Schema.Record(Schema.String, ModelSettings)),
  decisionModels: Schema.optional(Schema.Record(Schema.String, DecisionSettings)),
});

type RouteEntry = typeof RouteEntry.Type;

const SettingsFile = Schema.Struct({
  routes: Schema.optional(Schema.Record(Schema.String, RouteEntry)),
});

export class SettingsInvalid extends Schema.TaggedError<SettingsInvalid>()("SettingsInvalid", {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

type Settings = {
  /** The built-in routes, then the routes the user added. */
  readonly routes: ReadonlyArray<Route>;
  readonly routeSettings: ReadonlyMap<RouteId, RouteSettings>;
};

/** Reads `settings.json` in `tauDirectory`. If there is no file, Tau uses the built-in routes only. */
export const readSettings = Effect.fn("readSettings")(function* (tauDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = join(tauDirectory, "settings.json");
  const noSettings: Settings = { routes: builtInRoutes, routeSettings: new Map() };
  if (!(yield* fileSystem.exists(path))) return noSettings;

  const text = yield* fileSystem
    .readFileString(path)
    .pipe(Effect.mapError((cause) => unreadable(path, "cannot be read", cause)));

  const parsed = yield* Effect.try({
    try: () => Bun.JSONC.parse(text),
    catch: (cause) => unreadable(path, "is not valid JSON", cause),
  });

  const file = yield* Schema.decodeUnknownEffect(SettingsFile)(parsed).pipe(
    Effect.mapError((cause) => unreadable(path, `has a wrong value: ${cause.message}`, cause)),
  );

  const entries = Object.entries(file.routes ?? {});
  const added = yield* Effect.forEach(entries, ([id, entry]) => addedRoutes(path, id, entry));

  const routeSettings = new Map(
    entries.map(([id, entry]): [RouteId, RouteSettings] => [
      RouteId.make(id),
      { models: entry.models ?? {}, decisionModels: entry.decisionModels ?? {} },
    ]),
  );

  return { routes: [...builtInRoutes, ...added.flat()], routeSettings };
});

/**
 * Gives the new route that `entry` defines. An entry for a built-in route changes only its models,
 * so it gives no route.
 */
const addedRoutes = (path: string, id: string, entry: RouteEntry) => {
  const isBuiltIn = builtInRoutes.some((route) => route.id === RouteId.make(id));

  const changesConnection =
    entry.protocol !== undefined || entry.apiUrl !== undefined || entry.apiKeyEnv !== undefined;

  if (isBuiltIn && changesConnection) {
    return Effect.fail(
      invalid(
        path,
        `sets the address or key of routes.${id}, a built-in route. Change only its models`,
      ),
    );
  }

  if (isBuiltIn) return Effect.succeed([]);
  const { protocol, apiUrl, apiKeyEnv } = entry;

  if (protocol === undefined || apiUrl === undefined)
    return Effect.fail(invalid(path, `has no protocol or apiUrl for routes.${id}. Add both`));

  const route: Route = {
    id: RouteId.make(id),
    provider: ProviderId.make(id),
    protocol,
    apiUrl,
    auth:
      apiKeyEnv === undefined
        ? { kind: "none" }
        : { kind: "apiKey", environmentVariable: apiKeyEnv },
    catalogProvider: undefined,
    liveList: undefined,
    decisions: undefined,
    conversationHeaders: undefined,
  };

  return Effect.succeed([route]);
};

const invalid = (path: string, problem: string) =>
  new SettingsInvalid({ path, message: `${path} ${problem}.` });

const unreadable = (path: string, problem: string, cause: unknown) =>
  new SettingsInvalid({ path, message: `${path} ${problem}.`, cause });
