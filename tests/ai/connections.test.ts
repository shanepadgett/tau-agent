import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import { vendors } from "../../src/ai/Connections.ts";
import { ApiKey } from "../../src/ai/Credential.ts";
import { builtInProviders, ProviderTable } from "../../src/ai/Providers.ts";
import { neverPastes, providerNamed, run, withCredentials } from "../support/login-harness.ts";

const listVendors = withCredentials(neverPastes, (store) =>
  store
    .save(providerNamed("openai").id, ApiKey.make({ key: Redacted.make("saved-key") }))
    .pipe(
      Effect.andThen(vendors),
      Effect.provideService(ProviderTable, { providers: builtInProviders, settings: new Map() }),
    ),
);

describe("vendors", () => {
  test("groups the OpenAI providers and lists them by name", () =>
    run(
      Effect.gen(function* () {
        const listed = yield* listVendors;

        expect(listed.map((vendor) => vendor.name)).toEqual([
          "Anthropic",
          "OpenAI",
          "OpenCode Go",
          "OpenRouter",
        ]);

        const openai = listed.find((vendor) => vendor.id === "openai");

        expect(
          openai?.ways.map((way) => [
            way.provider.id,
            way.title,
            way.methods.map((method) => method.title),
          ]),
        ).toEqual([
          ["openai", "API key", []],
          ["chatgpt", "Sign in with ChatGPT", []],
          ["codex", "ChatGPT plan: Codex login", ["Browser", "Device code"]],
        ]);
      }),
    ));

  test("shows a saved key, an environment key, and no login", () =>
    run(
      Effect.gen(function* () {
        const states = Object.fromEntries(
          (yield* listVendors).map((vendor) => [vendor.id, vendor.state]),
        );

        expect(states).toEqual({
          openai: { kind: "saved" },
          openrouter: { kind: "environment", variable: "OPENROUTER_API_KEY" },
          anthropic: { kind: "none" },
          "opencode-go": { kind: "none" },
        });
      }),
    ));
});
