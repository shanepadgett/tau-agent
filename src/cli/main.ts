/** The `tau` command line: print mode, and logging in to and out of model providers. */

import { homedir } from "node:os";
import { join } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import packageJson from "../../package.json" with { type: "json" };
import { credentialStoreLayer } from "../host/credential-store.ts";
import { showFailure } from "./failure.ts";
import { loginCommand, logoutCommand, terminalLoginPrompt } from "./login.ts";
import { rootCommand } from "./print.ts";

const tauDirectory = join(homedir(), ".tau");

const appLayer = Layer.mergeAll(
  credentialStoreLayer(tauDirectory),
  FetchHttpClient.layer,
  terminalLoginPrompt,
).pipe(Layer.provideMerge(BunServices.layer));

rootCommand(tauDirectory).pipe(
  Command.withSubcommands([loginCommand(tauDirectory), logoutCommand(tauDirectory)]),
  Command.run({ version: packageJson.version }),
  Effect.catchTags({
    LoginFailed: showFailure,
    SettingsInvalid: showFailure,
    NoModel: showFailure,
    // Ctrl+C in a prompt ends the command quietly, like Ctrl+C anywhere else.
    QuitError: () => Effect.interrupt,
  }),
  Effect.provide(appLayer),
  BunRuntime.runMain,
);
