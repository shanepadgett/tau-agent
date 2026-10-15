/** Shared setup for the compaction and dreaming tests: a scripted catalog, replies and waits. */

import { Effect, Layer, Stream } from "effect";
import type { Prompt, Response } from "effect/ai";
import { Catalog, type ModelRef, UnknownModel } from "../../src/ai/Catalog.ts";
import type { ModelProfile } from "../../src/ai/ModelProfile.ts";
import { Models } from "../../src/ai/Models.ts";
import { builtInProviders } from "../../src/ai/Providers.ts";
import { ContextMethod } from "../../src/core/ContextMethod.ts";
import { type CompactionSettings, ContextSettings } from "../../src/core/ContextSettings.ts";
import type { EntryBody } from "../../src/session/Entry.ts";
import type { Notes } from "../../src/session/Notes.ts";
import { options, profile, type Reply } from "./agent-harness.ts";

const anthropic = builtInProviders.find((candidate) => candidate.id === "anthropic");
if (anthropic === undefined) throw new Error("Anthropic is a built-in provider.");
export const provider = anthropic;

export const contextLayer = (
  settings: CompactionSettings,
  quick = "available",
  limits: ModelProfile = profile,
) =>
  ContextMethod.layer.pipe(
    Layer.provide(Layer.succeed(ContextSettings, settings)),
    Layer.provide(
      Layer.succeed(
        Catalog,
        Catalog.of({
          model: (ref: ModelRef) =>
            ref.model === provider.smallModel && quick === "missing"
              ? Effect.fail(
                  new UnknownModel({
                    provider: ref.provider,
                    model: ref.model,
                    message: "Not offered.",
                  }),
                )
              : Effect.succeed({ provider, profile: limits }),
          decisionModel: () => Effect.die("Compaction uses chat models."),
          providerModels: Effect.succeed([]),
          claudeCodeVersion: Effect.succeed("test"),
          refreshIfStale: Effect.void,
        }),
      ),
    ),
    Layer.provide(smallModelLayer(quick)),
  );

/**
 * The agent's models, where the provider's small model is offered unless `quick` is `missing`.
 * Then notes go to the session's model, as `Models.smallModel` does.
 */
const smallModelLayer = (quick: string) =>
  Layer.effect(
    Models,
    Effect.map(Models, (models) =>
      Models.of({
        ...models,
        smallModel: (ref) =>
          Effect.succeed(
            quick === "missing" || provider.smallModel === undefined
              ? ref
              : { provider: ref.provider, model: provider.smallModel },
          ),
      }),
    ),
  );

export const assistant = (text: string): EntryBody => ({
  type: "assistant",
  model: options.model,
  interrupted: false,
  parts: [{ type: "text", text, providerData: {} }],
});

export const checkpointReply = (
  id: string,
  handoff = "Keep working on the recent request.",
): Reply =>
  Stream.make<Response.StreamPartEncoded[]>({
    type: "tool-call",
    id,
    name: "checkpoint",
    params: { handoff },
  });

export const counted = (reply: Reply, input: number, cacheRead = 0): Reply =>
  Stream.concat(
    reply,
    Stream.make<Response.StreamPartEncoded[]>({
      type: "finish",
      reason: "tool-calls",
      usage: { inputTokens: { total: input, cacheRead }, outputTokens: { total: 0 } },
    }),
  );

export const waitForNotes = (
  notes: Notes["Service"],
  session: Parameters<Notes["Service"]["list"]>[0],
  count: number,
) =>
  notes
    .list(session)
    .pipe(Effect.repeat({ until: (saved) => saved.length >= count }), Effect.timeout("5 seconds"));

export const waitForMemories = (
  notes: Notes["Service"],
  session: Parameters<Notes["Service"]["list"]>[0],
  count: number,
) =>
  notes
    .memories(session)
    .pipe(Effect.repeat({ until: (saved) => saved.length >= count }), Effect.timeout("5 seconds"));

export const promptText = (sent: Prompt.Prompt | undefined) => JSON.stringify(sent?.content);
