/** The `tau login` and `tau logout` commands, and the terminal prompts a login uses. */

import { Console, Effect, Layer, Option } from "effect";
import { Command, Prompt } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { CredentialStore } from "../../ai/Credential.ts";
import { logIn, LoginPrompt, logOut } from "../../ai/Login.ts";
import { type HeadlessLogin, type Provider, ProviderTable } from "../../ai/Providers.ts";

const AUTH_TITLES = {
  none: "no key",
  apiKey: "API key",
  claudeSubscription: "Claude subscription",
  chatgptApp: "ChatGPT plan: Sign in with ChatGPT",
  codexLogin: "ChatGPT plan: Codex login",
} satisfies Record<Provider["auth"]["kind"], string>;

const AUTH_DESCRIPTIONS = {
  none: "A server that needs no key",
  apiKey: "Saved in ~/.tau; without one, Tau reads the provider's environment variable",
  claudeSubscription: "Tau connects the way Claude Code does",
  chatgptApp: "Tau connects as its own app; set a usage cap in ChatGPT settings",
  codexLogin:
    "Tau connects the way the Codex CLI does; works with a device code, without a browser",
} satisfies Record<Provider["auth"]["kind"], string>;

/** Shown beside a provider that already has a saved credential. */
const SAVED_TITLES = {
  none: "saved",
  apiKey: "key saved",
  claudeSubscription: "logged in",
  chatgptApp: "logged in",
  codexLogin: "logged in",
} satisfies Record<Provider["auth"]["kind"], string>;

const HEADLESS_TITLES = {
  copyCode: "A browser anywhere, then paste the code it shows",
  deviceCode: "A browser anywhere, entering a code Tau shows",
} satisfies Record<HeadlessLogin["kind"], string>;

const providerChoice = (provider: Provider) => ({
  title: `${provider.id} (${AUTH_TITLES[provider.auth.kind]})`,
  description: AUTH_DESCRIPTIONS[provider.auth.kind],
  value: provider,
});

/** The providers that take a login or a key: the built-in ones and those in the user's settings. */
const providersWithCredentials = ProviderTable.use(({ providers }) =>
  Effect.succeed(providers.filter((provider) => provider.auth.kind !== "none")),
);

/** The providers whose provider has a saved login or key. */
const savedProviders = Effect.fn("savedProviders")(function* (providers: readonly Provider[]) {
  const store = yield* CredentialStore;

  return yield* Effect.filter(providers, (provider) =>
    store.read(provider.id).pipe(Effect.map(Option.isSome)),
  );
});

/** A login choice says whether its provider is already logged in, so the user sees what is missing. */
const loginChoice = (saved: readonly Provider[]) => (provider: Provider) => {
  const choice = providerChoice(provider);
  const kind = provider.auth.kind;

  return saved.includes(provider)
    ? { ...choice, title: `${provider.id} (${AUTH_TITLES[kind]}, ${SAVED_TITLES[kind]})` }
    : choice;
};

export const loginCommand = Command.make(
  "login",
  {},
  Effect.fn("login")(function* () {
    const providers = yield* providersWithCredentials;
    const saved = yield* savedProviders(providers);

    const provider = yield* Prompt.Select({
      message: "Log in to",
      choices: providers.map(loginChoice(saved)),
    });

    yield* logIn(provider);
    yield* Console.log(`Logged in to ${provider.id}.`);
  }),
).pipe(Command.withDescription("Log in to a model provider."));

export const logoutCommand = Command.make(
  "logout",
  {},
  Effect.fn("logout")(function* () {
    const loggedIn = yield* savedProviders(yield* providersWithCredentials);

    if (loggedIn.length === 0)
      return yield* Console.log("No provider has a saved login or API key.");

    const provider = yield* Prompt.Select({
      message: "Log out of",
      choices: loggedIn.map(providerChoice),
    });

    yield* logOut(provider);
    yield* Console.log(`Logged out of ${provider.id}.`);
  }),
).pipe(Command.withDescription("Remove a saved login or API key."));

const BROWSER_COMMAND = process.platform === "darwin" ? "open" : "xdg-open";

export const terminalLoginPrompt = Layer.effect(
  LoginPrompt,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const terminal = yield* Effect.context<Prompt.Environment>();

    // Ctrl+C in a prompt during a login stops the login.
    const terminalPrompt = <A>(prompt: Prompt.Prompt<A>) =>
      prompt.pipe(
        Effect.provideContext(terminal),
        Effect.catchTag("QuitError", () => Effect.interrupt),
      );

    return LoginPrompt.of({
      openBrowser: (url) =>
        Console.log(`Open this address to log in:\n${url}`).pipe(
          Effect.andThen(spawner.exitCode(ChildProcess.make(BROWSER_COMMAND, [url]))),
          // The address is printed, so a machine with no browser can still log in.
          Effect.ignore,
        ),
      show: (text) => Console.log(text),
      ask: (question) => terminalPrompt(Prompt.String({ message: question })),
      askSecret: (question) => terminalPrompt(Prompt.Password({ message: question })),
      chooseMethod: (headless) =>
        terminalPrompt(
          Prompt.Select({
            message: "Log in with",
            choices: [
              { title: "A browser on this machine", value: "browser" as const },
              { title: HEADLESS_TITLES[headless.kind], value: "headless" as const },
            ],
          }),
        ),
    });
  }),
);
