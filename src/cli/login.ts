/** The `tau login` and `tau logout` commands, and the terminal prompts a login uses. */

import { Console, Effect, Layer, Option, Schema } from "effect";
import { Command, Prompt } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { logInChatgptApp, revokeChatgptApp } from "../ai/chatgpt-app.ts";
import { ApiKey, ChatgptAppTokens, CredentialStore, type Credential } from "../ai/credential.ts";
import { logIn, LoginPrompt } from "../ai/login.ts";
import type { ChatgptApp, HeadlessLogin, Route } from "../ai/routes.ts";
import { readOrCreateHostId } from "../host/host-id.ts";
import { readSettings } from "../host/settings.ts";

const AUTH_TITLES = {
  none: "no key",
  apiKey: "API key",
  claudeSubscription: "Claude subscription",
  chatgptApp: "ChatGPT plan: Sign in with ChatGPT",
  codexLogin: "ChatGPT plan: Codex login",
} satisfies Record<Route["auth"]["kind"], string>;

const AUTH_DESCRIPTIONS = {
  none: "A server that needs no key",
  apiKey: "Saved in ~/.tau; without one, Tau reads the provider's environment variable",
  claudeSubscription: "Tau connects the way Claude Code does",
  chatgptApp: "Tau connects as its own app; set a usage cap in ChatGPT settings",
  codexLogin:
    "Tau connects the way the Codex CLI does; works with a device code, without a browser",
} satisfies Record<Route["auth"]["kind"], string>;

const HEADLESS_TITLES = {
  copyCode: "A browser anywhere, then paste the code it shows",
  deviceCode: "A browser anywhere, entering a code Tau shows",
} satisfies Record<HeadlessLogin["kind"], string>;

const routeChoice = (route: Route) => ({
  title: `${route.provider} (${AUTH_TITLES[route.auth.kind]})`,
  description: AUTH_DESCRIPTIONS[route.auth.kind],
  value: route,
});

/** The routes that take a login or a key: the built-in ones and those in the user's settings. */
const routesWithCredentials = (tauDirectory: string) =>
  readSettings(tauDirectory).pipe(
    Effect.map(({ routes }) =>
      routes.flatMap((route) => (route.auth.kind === "none" ? [] : [route])),
    ),
  );

export const loginCommand = (tauDirectory: string) =>
  Command.make(
    "login",
    {},
    Effect.fn("login")(function* () {
      const route = yield* Prompt.Select({
        message: "Log in to",
        choices: (yield* routesWithCredentials(tauDirectory)).map(routeChoice),
      });

      if (route.auth.kind === "none")
        return yield* Console.log(`${route.provider} needs no login.`);

      if (route.auth.kind === "apiKey") {
        const key = yield* Prompt.Password({ message: `${route.provider} API key` });
        yield* (yield* CredentialStore).save(route.provider, ApiKey.make({ key }));
      } else if (route.auth.kind === "chatgptApp") {
        const hostId = yield* readOrCreateHostId(tauDirectory);
        yield* logInChatgptApp(route.provider, route.auth.app, hostId);
      } else {
        const method = yield* Prompt.Select({
          message: "Log in with",
          choices: [
            { title: "A browser on this machine", value: "browser" },
            { title: HEADLESS_TITLES[route.auth.oauth.headless.kind], value: "headless" },
          ],
        });

        yield* logIn(route.provider, route.auth.oauth, method);
      }

      yield* Console.log(`Logged in to ${route.provider}.`);
    }),
  ).pipe(Command.withDescription("Log in to a model provider."));

export const logoutCommand = (tauDirectory: string) =>
  Command.make(
    "logout",
    {},
    Effect.fn("logout")(function* () {
      const store = yield* CredentialStore;

      const loggedIn = yield* Effect.filter(yield* routesWithCredentials(tauDirectory), (route) =>
        store.read(route.provider).pipe(Effect.map(Option.isSome)),
      );

      if (loggedIn.length === 0)
        return yield* Console.log("No provider has a saved login or API key.");

      const route = yield* Prompt.Select({
        message: "Log out of",
        choices: loggedIn.map(routeChoice),
      });

      if (route.auth.kind === "chatgptApp") {
        yield* revokeOrWarn(route.auth.app, yield* store.read(route.provider));
      }

      yield* store.remove(route.provider);
      yield* Console.log(`Logged out of ${route.provider}.`);
    }),
  ).pipe(Command.withDescription("Remove a saved login or API key."));

/** Ends a Sign in with ChatGPT login on OpenAI's side; when that fails, says how to end it by hand. */
const revokeOrWarn = (app: ChatgptApp, stored: Option.Option<Credential>) => {
  const tokens = Option.filter(stored, Schema.is(ChatgptAppTokens));
  if (Option.isNone(tokens)) return Effect.void;

  return revokeChatgptApp(app, tokens.value).pipe(
    Effect.catchTag("HttpClientError", (error) =>
      Console.log(
        `OpenAI did not confirm the logout (${error.message}). To end it on OpenAI's side, disconnect Tau in ChatGPT settings at chatgpt.com/settings/usage.`,
      ),
    ),
  );
};

const BROWSER_COMMAND = process.platform === "darwin" ? "open" : "xdg-open";

export const terminalLoginPrompt = Layer.effect(
  LoginPrompt,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const terminal = yield* Effect.context<Prompt.Environment>();

    return LoginPrompt.of({
      openBrowser: (url) =>
        Console.log(`Open this address to log in:\n${url}`).pipe(
          Effect.andThen(spawner.exitCode(ChildProcess.make(BROWSER_COMMAND, [url]))),
          // The address is printed, so a machine with no browser can still log in.
          Effect.ignore,
        ),
      show: (text) => Console.log(text),
      ask: (question) =>
        Prompt.String({ message: question }).pipe(
          Effect.provideContext(terminal),
          Effect.catchTag("QuitError", () => Effect.interrupt),
        ),
    });
  }),
);
