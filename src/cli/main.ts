/** The `tau` command line: print mode, and logging in to and out of model providers. */

import { homedir } from "node:os";
import { join } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import packageJson from "../../package.json" with { type: "json" };
import { TauHome } from "../database/TauHome.ts";
import { catalogCacheLayer } from "../host/CatalogCache.ts";
import { credentialStoreLayer } from "../host/CredentialStore.ts";
import { hostIdLayer } from "../host/HostId.ts";
import { Settings } from "../host/Settings.ts";
import { outputFolderLayer } from "../host/OutputFolder.ts";
import { showFailure } from "./internal/failure.ts";
import { loginCommand, logoutCommand, terminalLoginPrompt } from "./internal/login.ts";
import { rootCommand } from "./internal/print.ts";

const appLayer = Layer.mergeAll(
  credentialStoreLayer,
  catalogCacheLayer,
  hostIdLayer,
  Settings.layer,
  outputFolderLayer,
  FetchHttpClient.layer,
  terminalLoginPrompt,
).pipe(
  Layer.provideMerge(TauHome.at(join(homedir(), ".tau"))),
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
    // Ctrl+C in a prompt ends the command quietly, like Ctrl+C anywhere else.
    QuitError: () => Effect.interrupt,
  }),
  BunRuntime.runMain,
);
