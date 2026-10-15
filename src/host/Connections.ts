/** Gives the `Connections` service: the vendors from the provider table, and logins through `ai/Login.ts`. */

import { Crypto, Effect, Layer, Predicate } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Catalog } from "../ai/Catalog.ts";
import { vendors } from "../ai/Connections.ts";
import { CredentialStore } from "../ai/Credential.ts";
import { HostId, logIn, LoginPrompt, logOut } from "../ai/Login.ts";
import { ProviderTable } from "../ai/Providers.ts";
import { type ConnectPrompt, Connections } from "../core/Connections.ts";

// A login can fail in ways the types do not name; the dialog shows only the message.
const failureOf = Effect.mapError((error) =>
  Predicate.hasProperty(error, "message") && Predicate.isString(error.message)
    ? { message: error.message }
    : { message: "The login failed." },
);

const BROWSER_COMMAND = process.platform === "darwin" ? "open" : "xdg-open";

export const connectionsLayer = Layer.effect(
  Connections,
  Effect.gen(function* () {
    // A login runs after the layer is built, so it takes its services from here.
    const context = yield* Effect.context<
      CredentialStore | Crypto.Crypto | HostId | HttpClient.HttpClient | ProviderTable
    >();

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const catalog = yield* Catalog;

    // The dialog shows the address; this also opens it, which a machine with no browser ignores.
    const withBrowser = (prompt: ConnectPrompt): ConnectPrompt => ({
      ...prompt,
      openBrowser: (url) =>
        prompt
          .openBrowser(url)
          .pipe(
            Effect.andThen(spawner.exitCode(ChildProcess.make(BROWSER_COMMAND, [url]))),
            Effect.ignore,
          ),
    });

    return Connections.of({
      vendors: vendors.pipe(Effect.provideContext(context)),
      logIn: (way, prompt) =>
        logIn(way.provider).pipe(
          Effect.provideService(LoginPrompt, withBrowser(prompt)),
          Effect.provideContext(context),
          // The new login may allow models that the catalog has not listed yet.
          Effect.tap(() => catalog.refreshIfStale),
          failureOf,
        ),
      logOut: (way, prompt) =>
        logOut(way.provider).pipe(
          Effect.provideService(LoginPrompt, prompt),
          Effect.provideContext(context),
        ),
    });
  }),
);
