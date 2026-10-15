/** The `tau` command line: the chat in the terminal, print mode, and logging in to and out of model providers. */

import { homedir } from "node:os";
import { join } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import packageJson from "../../package.json" with { type: "json" };
import { Status } from "../core/Status.ts";
import { TauHome } from "../database/TauHome.ts";
import { catalogCacheLayer } from "../host/CatalogCache.ts";
import { credentialStoreLayer } from "../host/CredentialStore.ts";
import { favoriteModelsLayer } from "../host/FavoriteModels.ts";
import { stashesLayer } from "../host/Stashes.ts";
import { hostIdLayer } from "../host/HostId.ts";
import { logFileLayer } from "../host/LogFile.ts";
import { referencesLayer } from "../host/References.ts";
import { Settings } from "../host/Settings.ts";
import { tuiMemoryLayer } from "../host/TuiMemory.ts";
import { outputFolderLayer } from "../host/OutputFolder.ts";
import { ReloadLink } from "../supervisor/ReloadLink.ts";
import { FileIndex } from "../workspace/FileIndex.ts";
import { showFailure } from "./internal/failure.ts";
import { loginCommand, logoutCommand, terminalLoginPrompt } from "./internal/login.ts";
import { rootCommand } from "./internal/root-command.ts";

const TAU_DIRECTORY = join(homedir(), ".tau");

const appLayer = Layer.mergeAll(
  referencesLayer,
  FileIndex.at(join(TAU_DIRECTORY, "files")),
  credentialStoreLayer,
  catalogCacheLayer,
  favoriteModelsLayer,
  stashesLayer,
  tuiMemoryLayer,
  hostIdLayer,
  outputFolderLayer,
  terminalLoginPrompt,
  ReloadLink.layer,
  Status.layer,
  logFileLayer,
).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(TauHome.at(TAU_DIRECTORY)),
  Layer.provideMerge(BunServices.layer),
);

rootCommand.pipe(
  Command.withSubcommands([loginCommand, logoutCommand]),
  Command.run({ version: packageJson.version }),
  Effect.provide(appLayer),
  Effect.catchTags({
    LoginFailed: showFailure,
    SettingsInvalid: showFailure,
    NoModel: showFailure,
    TauCrashed: showFailure,
    // Ctrl+C in a prompt ends the command quietly, like Ctrl+C anywhere else.
    QuitError: () => Effect.interrupt,
  }),
  BunRuntime.runMain,
);
