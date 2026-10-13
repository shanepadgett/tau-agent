/** Reads the user's settings from `~/.tau/settings.json`. The file can contain comments. */

import { join } from "node:path";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { ProviderId } from "../ai/Credential.ts";
import { DecisionSettings, ModelSettings, Protocol } from "../ai/ModelProfile.ts";
import {
  builtInRoutes,
  type Route,
  RouteId,
  type RouteSettings,
  RouteTable,
} from "../ai/Routes.ts";
import { TauHome } from "../database/TauHome.ts";

const RouteEntry = Schema.Struct({
  protocol: Schema.optional(Protocol),
  apiUrl: Schema.optional(Schema.String),
  /** The environment variable that holds the key. Without it, the route sends no key. */
  apiKeyEnv: Schema.optional(Schema.String),
  models: Schema.optional(Schema.Record(Schema.String, ModelSettings)),
  decisionModels: Schema.optional(Schema.Record(Schema.String, DecisionSettings)),
});

type RouteEntry = typeof RouteEntry.Type;

const Seconds = Schema.Finite.check(Schema.isGreaterThan(0));

const SettingsFile = Schema.Struct({
  routes: Schema.optional(Schema.Record(Schema.String, RouteEntry)),
  /** The model a run uses, written `route/model`. */
  model: Schema.optional(Schema.String),
  /** Ends a run after this many turns. There is no limit without it. */
  maxTurns: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  /** Defaults for one `run` call and one shell command. The model can change them per call. */
  timeouts: Schema.optional(
    Schema.Struct({ run: Schema.optional(Seconds), shell: Schema.optional(Seconds) }),
  ),
  /** `false` turns off every agents file, the user's and the project's. */
  agentsFiles: Schema.optional(Schema.Boolean),
});

/** What a run uses from the settings file. Each value is absent when the file does not set it. */
export type RunSettings = {
  readonly model: string | undefined;
  readonly maxTurns: number | undefined;
  readonly runTimeoutSeconds: number | undefined;
  readonly shellTimeoutSeconds: number | undefined;
};

class SettingsInvalid extends Schema.TaggedError<SettingsInvalid>()("SettingsInvalid", {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** The settings that change how a run behaves. The route table is a separate service of the AI layer. */
export class Settings extends Context.Service<
  Settings,
  {
    readonly run: RunSettings;
    /** Whether Tau reads agents files. */
    readonly agentsFiles: boolean;
  }
>()("tau/host/Settings") {
  /** Reads `settings.json` in Tau's home folder once, and gives the run settings and the route table. */
  static readonly layer = Layer.effectContext(
    TauHome.use(({ directory }) => readSettingsFile(join(directory, "settings.json"))).pipe(
      Effect.map(({ routes, routeSettings, run, agentsFiles }) =>
        Context.make(Settings, { run, agentsFiles }).pipe(
          Context.add(RouteTable, { routes, settings: routeSettings }),
        ),
      ),
    ),
  );
}

type SettingsFileContent = {
  readonly routes: ReadonlyArray<Route>;
  readonly routeSettings: ReadonlyMap<RouteId, RouteSettings>;
  readonly run: RunSettings;
  readonly agentsFiles: boolean;
};

const noRunSettings: RunSettings = {
  model: undefined,
  maxTurns: undefined,
  runTimeoutSeconds: undefined,
  shellTimeoutSeconds: undefined,
};

/** If there is no file, Tau uses the built-in routes only. */
const readSettingsFile = Effect.fn("readSettingsFile")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;

  const noSettings: SettingsFileContent = {
    routes: builtInRoutes,
    routeSettings: new Map(),
    run: noRunSettings,
    agentsFiles: true,
  };

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

  const run: RunSettings = {
    model: file.model,
    maxTurns: file.maxTurns,
    runTimeoutSeconds: file.timeouts?.run,
    shellTimeoutSeconds: file.timeouts?.shell,
  };

  const content: SettingsFileContent = {
    routes: [...builtInRoutes, ...added.flat()],
    routeSettings,
    run,
    agentsFiles: file.agentsFiles ?? true,
  };

  return content;
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
