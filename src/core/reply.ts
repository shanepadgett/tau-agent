/** Turns the parts of a model's streamed reply into the assistant entry Tau saves. */

import { Effect, Schema } from "effect";
import { Prompt, type Response } from "effect/ai";
import type { ModelRef } from "../ai/catalog.ts";
import type { EntryBody } from "../session/entry.ts";

type AssistantEntry = Extract<EntryBody, { type: "assistant" }>;
type Part = AssistantEntry["parts"][number];

const toJson = Schema.decodeUnknownEffect(Schema.Json);

/** The finished reply. Effect's `fromResponseParts` joins the streamed pieces of each part. */
export const replyEntry = Effect.fn("replyEntry")(function* (
  model: ModelRef,
  parts: readonly Response.AnyPart[],
) {
  const content = Prompt.fromResponseParts(parts).content.flatMap((message) =>
    message.role === "assistant" ? message.content : [],
  );

  const saved = yield* Effect.forEach(content, savedPart);

  const entry: AssistantEntry = {
    type: "assistant",
    model,
    parts: saved.flat(),
    interrupted: false,
  };

  return entry;
});

/**
 * The text a reply had when it was cut short, or nothing if it had none. A streamed part is only
 * complete at its end, so the text comes from the pieces received.
 */
export const interruptedEntry = (
  model: ModelRef,
  parts: readonly Response.AnyPart[],
): AssistantEntry | undefined => {
  const text = parts.map((part) => (part.type === "text-delta" ? part.delta : "")).join("");
  if (text === "") return undefined;

  return {
    type: "assistant",
    model,
    parts: [{ type: "text", text, providerData: {} }],
    interrupted: true,
  };
};

const savedPart = (part: Prompt.AssistantMessagePart): Effect.Effect<readonly Part[]> => {
  switch (part.type) {
    case "text":
      return Effect.succeed([{ type: "text", text: part.text, providerData: part.options }]);
    case "reasoning":
      return Effect.succeed([{ type: "reasoning", text: part.text, providerData: part.options }]);
    case "tool-call":
      // Tool parameters come from the model's JSON, so they always decode.
      return toJson(part.params).pipe(
        Effect.orDie,
        Effect.map((params) => [
          { type: "tool-call", id: part.id, name: part.name, params, providerData: part.options },
        ]),
      );
    case "file":
    case "tool-result":
    case "tool-approval-request":
      return Effect.succeed([]);
  }
};
