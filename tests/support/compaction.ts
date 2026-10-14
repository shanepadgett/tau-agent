/** Shared setup for the compaction and dreaming tests: a scripted catalog, replies and waits. */

import { Effect, Layer, Stream } from "effect";
import type { Prompt, Response } from "effect/ai";
import { Catalog, type ModelRef, UnknownModel } from "../../src/ai/Catalog.ts";
import type { ModelProfile } from "../../src/ai/ModelProfile.ts";
import { builtInRoutes } from "../../src/ai/Routes.ts";
import { ContextMethod } from "../../src/core/ContextMethod.ts";
import { type CompactionSettings, ContextSettings } from "../../src/core/ContextSettings.ts";
import type { EntryBody } from "../../src/session/Entry.ts";
import type { Notes } from "../../src/session/Notes.ts";
import { options, type Reply } from "./agent-harness.ts";

const anthropic = builtInRoutes.find((candidate) => candidate.id === "anthropic");
if (anthropic === undefined) throw new Error("Anthropic is a built-in route.");
export const route = anthropic;

export const profile: ModelProfile = {
  id: "scripted",
  name: "Scripted",
  protocol: "openaiChat",
  contextTokens: 128000,
  outputTokens: 8000,
  price: undefined,
  longContextPrice: undefined,
  supports: { tools: true, structuredOutput: false, reasoning: false, images: false },
};

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
            ref.model === route.noteModel && quick === "missing"
              ? Effect.fail(
                  new UnknownModel({ route: ref.route, model: ref.model, message: "Not offered." }),
                )
              : Effect.succeed({ route, profile: limits }),
          decisionModel: () => Effect.die("Compaction uses chat models."),
          claudeCodeVersion: Effect.succeed("test"),
          refreshIfStale: Effect.void,
        }),
      ),
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
