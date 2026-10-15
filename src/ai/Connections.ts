/**
 * Lists the providers a user can sign in to, grouped by vendor, with each way to sign in and whether
 * the provider already has a saved login or key. `/connect` shows this list.
 */

import { Config, Effect, Option } from "effect";
import { CredentialStore, type CredentialStoreError } from "./Credential.ts";
import type { LoginMethod } from "./internal/login/login-services.ts";
import { type Provider, ProviderTable } from "./Providers.ts";

/** Whether a provider has a saved login or key, or reads its key from an environment variable. */
export type SignInState =
  | { readonly kind: "none" }
  | { readonly kind: "saved" }
  | { readonly kind: "environment"; readonly variable: string };

/** One way of finishing a login, such as in a browser or with a device code. */
export type Method = { readonly method: LoginMethod; readonly title: string };

/** One login of a vendor's list: what the user signs in to, and the ways to finish it. */
export type Way = {
  readonly provider: Provider;
  readonly title: string;
  /** The ways to finish the login; none when the login has no choice. */
  readonly methods: readonly Method[];
  readonly state: SignInState;
};

export type VendorWays = {
  readonly id: string;
  readonly name: string;
  readonly ways: readonly Way[];
  readonly state: SignInState;
};

type WayTitle = Pick<Way, "title" | "methods">;

const BROWSER: Method = { method: "browser", title: "Browser" };

const waysOf = (provider: Provider): readonly WayTitle[] => {
  const { auth } = provider;

  switch (auth.kind) {
    case "none":
      return [];
    case "apiKey":
      return [{ title: "API key", methods: [] }];
    case "chatgptApp":
      return [{ title: "Sign in with ChatGPT", methods: [] }];
    case "claudeSubscription":
      return [
        {
          title: "Claude subscription",
          methods: [BROWSER, { method: "headless", title: "Paste a code" }],
        },
      ];
    case "codexLogin":
      return [
        {
          title: "ChatGPT plan: Codex login",
          methods: [BROWSER, { method: "headless", title: "Device code" }],
        },
      ];
  }
};

/** The state of `provider`: a saved credential, else an API key in its environment variable. */
const signInState = Effect.fn("signInState")(function* (provider: Provider) {
  const store = yield* CredentialStore;

  if (Option.isSome(yield* store.read(provider.id))) return { kind: "saved" } as const;
  if (provider.auth.kind !== "apiKey") return { kind: "none" } as const;

  const { environmentVariable } = provider.auth;

  // An unset variable is `none`; reading the environment itself cannot fail.
  const key = yield* Config.option(Config.Redacted(environmentVariable)).pipe(Effect.orDie);

  return Option.isSome(key)
    ? ({ kind: "environment", variable: environmentVariable } as const)
    : ({ kind: "none" } as const);
});

/** A vendor is signed in when any of its ways is saved; a variable counts only when none is. */
const vendorState = (ways: readonly Way[]): SignInState =>
  ways.find((way) => way.state.kind === "saved")?.state ??
  ways.find((way) => way.state.kind === "environment")?.state ?? { kind: "none" };

/** The vendors with a way to sign in, by name. */
export const vendors: Effect.Effect<
  readonly VendorWays[],
  CredentialStoreError,
  ProviderTable | CredentialStore
> = Effect.gen(function* () {
  const { providers } = yield* ProviderTable;
  const byVendor = new Map<string, { name: string; ways: Way[] }>();

  for (const provider of providers) {
    const titles = waysOf(provider);
    if (titles.length === 0) continue;

    const state = yield* signInState(provider);
    const { id, name } = provider.vendor ?? { id: provider.id, name: provider.id };
    const entry = byVendor.get(id) ?? { name, ways: [] };
    entry.ways.push(...titles.map((title) => ({ provider, ...title, state })));
    byVendor.set(id, entry);
  }

  return [...byVendor.entries()]
    .map(([id, { name, ways }]) => ({ id, name, ways, state: vendorState(ways) }))
    .toSorted((first, second) => first.name.localeCompare(second.name));
});
