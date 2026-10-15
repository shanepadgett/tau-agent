/** Reads the user's settings from `~/.tau/settings.json`. The file can contain comments. */

import { join } from "node:path";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { DecisionSettings, ModelSettings, Protocol } from "../ai/ModelProfile.ts";
import {
  builtInProviders,
  type Provider,
  ProviderId,
  type ProviderSettings,
  ProviderTable,
} from "../ai/Providers.ts";
import { TauHome } from "../database/TauHome.ts";
import { CompactionSettings, ContextSettings } from "../core/ContextSettings.ts";
import { CommitSettings } from "../core/Commits.ts";

const ProviderEntry = Schema.Struct({
  protocol: Schema.optional(Protocol),
  apiUrl: Schema.optional(Schema.String),
  /** The environment variable that holds the key. Without it, the provider sends no key. */
  apiKeyEnv: Schema.optional(Schema.String),
  models: Schema.optional(Schema.Record(Schema.String, ModelSettings)),
  decisionModels: Schema.optional(Schema.Record(Schema.String, DecisionSettings)),
  /** The cheap model for background notes, memory and `/commit`, in place of the built-in one. */
  smallModel: Schema.optional(Schema.String),
});

type ProviderEntry = typeof ProviderEntry.Type;

const Seconds = Schema.Finite.check(Schema.isGreaterThan(0));

const SettingsFile = Schema.Struct({
  providers: Schema.optional(Schema.Record(Schema.String, ProviderEntry)),
  /** The model a run uses, written `provider/model`. */
  model: Schema.optional(Schema.String),
  /** Ends a run after this many turns. There is no limit without it. */
  maxTurns: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  /** Defaults for one `run` call and one shell command. The model can change them per call. */
  timeouts: Schema.optional(
    Schema.Struct({ run: Schema.optional(Seconds), shell: Schema.optional(Seconds) }),
  ),
  /** `false` turns off every agents file, the user's and the project's. */
  agentsFiles: Schema.optional(Schema.Boolean),
  /** `false` makes `/restart` the only way to restart into Tau's changed code. */
  autoRestart: Schema.optional(Schema.Boolean),
  compaction: Schema.optional(CompactionSettings),
  /** How `/commit` ends: `push` is `"ask"` (the default), `true` or `false`. */
  commit: Schema.optional(
    Schema.Struct({
      push: Schema.optional(Schema.Union([Schema.Literal("ask"), Schema.Boolean])),
      avoidBreakingChanges: Schema.optional(Schema.Boolean),
    }),
  ),
  /** The least severe log level that `~/.tau/logs` keeps. */
  logLevel: Schema.optional(Schema.Literals(["Error", "Warn", "Info", "Debug"])),
});

type LogLevel = NonNullable<typeof SettingsFile.Type.logLevel>;

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

/** The settings that change how a run behaves. The provider table is a separate service of the AI layer. */
export class Settings extends Context.Service<
  Settings,
  {
    readonly run: RunSettings;
    /** Whether Tau reads agents files. */
    readonly agentsFiles: boolean;
    /** Whether Tau restarts into its changed code by itself when it is idle. */
    readonly autoRestart: boolean;
    readonly logLevel: LogLevel;
  }
>()("tau/host/Settings") {
  /** Reads `settings.json` in Tau's home folder once, and gives the run settings and the provider table. */
  static readonly layer = Layer.effectContext(
    TauHome.use(({ directory }) => readSettingsFile(join(directory, "settings.json"))).pipe(
      Effect.map(({ providers, providerSettings, compaction, commit, ...settings }) =>
        Context.make(Settings, settings).pipe(
          Context.add(ProviderTable, { providers, settings: providerSettings }),
          Context.add(ContextSettings, compaction),
          Context.add(CommitSettings, commit),
        ),
      ),
    ),
  );
}

type SettingsFileContent = {
  readonly providers: ReadonlyArray<Provider>;
  readonly providerSettings: ReadonlyMap<ProviderId, ProviderSettings>;
  readonly run: RunSettings;
  readonly agentsFiles: boolean;
  readonly autoRestart: boolean;
  readonly logLevel: LogLevel;
  readonly compaction: CompactionSettings;
  readonly commit: CommitSettings;
};

const noRunSettings: RunSettings = {
  model: undefined,
  maxTurns: undefined,
  runTimeoutSeconds: undefined,
  shellTimeoutSeconds: undefined,
};

/** If there is no file, Tau uses the built-in providers only. */
const readSettingsFile = Effect.fn("readSettingsFile")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;

  const noSettings: SettingsFileContent = {
    providers: builtInProviders,
    providerSettings: new Map(),
    run: noRunSettings,
    agentsFiles: true,
    autoRestart: true,
    logLevel: "Warn",
    compaction: {},
    commit: { push: "ask", avoidBreakingChanges: false },
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

  const entries = Object.entries(file.providers ?? {});
  const added = yield* Effect.forEach(entries, ([id, entry]) => addedProviders(path, id, entry));

  const providerSettings = new Map(
    entries.map(([id, entry]): [ProviderId, ProviderSettings] => [
      ProviderId.make(id),
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
    providers: [...builtInProviders, ...added.flat()].map((provider) =>
      withSmallModel(provider, file.providers?.[provider.id]?.smallModel),
    ),
    providerSettings,
    run,
    agentsFiles: file.agentsFiles ?? true,
    autoRestart: file.autoRestart ?? true,
    logLevel: file.logLevel ?? "Warn",
    compaction: file.compaction ?? {},
    commit: {
      push: file.commit?.push ?? "ask",
      avoidBreakingChanges: file.commit?.avoidBreakingChanges ?? false,
    },
  };

  return content;
});

/**
 * Gives the new provider that `entry` defines. An entry for a built-in provider changes only its models,
 * so it gives no provider. Its `smallModel` is applied afterwards.
 */
const addedProviders = (path: string, id: string, entry: ProviderEntry) => {
  const isBuiltIn = builtInProviders.some((provider) => provider.id === ProviderId.make(id));

  const changesConnection =
    entry.protocol !== undefined || entry.apiUrl !== undefined || entry.apiKeyEnv !== undefined;

  if (isBuiltIn && changesConnection) {
    return Effect.fail(
      invalid(
        path,
        `sets the address or key of providers.${id}, a built-in provider. Change only its models`,
      ),
    );
  }

  if (isBuiltIn) return Effect.succeed([]);
  const { protocol, apiUrl, apiKeyEnv } = entry;

  if (protocol === undefined || apiUrl === undefined)
    return Effect.fail(invalid(path, `has no protocol or apiUrl for providers.${id}. Add both`));

  const provider: Provider = {
    id: ProviderId.make(id),
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
    hostedSearch: undefined,
  };

  return Effect.succeed([provider]);
};

const withSmallModel = (provider: Provider, smallModel: string | undefined): Provider =>
  smallModel === undefined ? provider : { ...provider, smallModel };

const invalid = (path: string, problem: string) =>
  new SettingsInvalid({ path, message: `${path} ${problem}.` });

const unreadable = (path: string, problem: string, cause: unknown) =>
  new SettingsInvalid({ path, message: `${path} ${problem}.`, cause });
