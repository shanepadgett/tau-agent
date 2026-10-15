/** Turns the saved entries of a session into the events a client shows, so a resumed chat shows its past runs. */

import { Effect, Option } from "effect";
import { formatModelRef } from "../../../ai/Catalog.ts";
import type { ModelProfile } from "../../../ai/ModelProfile.ts";
import type { Models } from "../../../ai/Models.ts";
import type { EntryBody, Entry } from "../../../session/Entry.ts";
import type { AgentEvent } from "../../Client.ts";
import { modelCall } from "../loop/reply.ts";
import { summary } from "../loop/tool-history.ts";

type AssistantPart = Extract<EntryBody, { type: "assistant" }>["parts"][number];
type Profiles = ReadonlyMap<string, ModelProfile>;

/**
 * The profiles of the models that replied in the session. A model no longer in the catalog has
 * none, so its calls show no usage.
 */
export const replyProfiles = Effect.fn("replyProfiles")(function* (
  models: Models["Service"],
  entries: readonly Entry[],
) {
  const refs = new Map(
    entries.flatMap(({ body }) =>
      body.type === "assistant" ? [[formatModelRef(body.model), body.model] as const] : [],
    ),
  );

  const found = yield* Effect.forEach(refs, ([key, ref]) =>
    models
      .profile(ref)
      .pipe(Effect.option, Effect.map(Option.map((profile) => [key, profile] as const))),
  );

  return new Map(found.flatMap(Option.toArray));
});

export const historyEvents = (
  entries: readonly Entry[],
  profiles: Profiles,
): readonly AgentEvent[] => entries.flatMap(({ body }) => bodyEvents(body, profiles));

const bodyEvents = (body: EntryBody, profiles: Profiles): readonly AgentEvent[] => {
  switch (body.type) {
    case "user":
      return body.steering === true
        ? [{ type: "steered", text: body.text }]
        : [{ type: "run-started", prompt: body.text }];
    case "assistant":
      return [...body.parts.flatMap(partEvents), ...callEvents(body, profiles)];
    case "tool-result":
      return [{ type: "tool-ended", callId: body.callId, isFailure: body.isFailure }];
    case "run-failed":
      return [{ type: "run-ended", reason: "failed", error: body.error }];
    case "tool-started":
    case "checks":
    case "instructions":
    case "nudge":
      return [];
  }
};

const callEvents = (
  reply: Extract<EntryBody, { type: "assistant" }>,
  profiles: Profiles,
): readonly AgentEvent[] => {
  const profile = profiles.get(formatModelRef(reply.model));
  if (profile === undefined || reply.tokens === undefined) return [];

  return [{ type: "model-call-ended", call: modelCall(reply.model, profile, reply.tokens) }];
};

const partEvents = (part: AssistantPart): readonly AgentEvent[] => {
  switch (part.type) {
    case "text":
      return [{ type: "text", delta: part.text }];
    case "tool-call":
      return [{ type: "tool-started", callId: part.id, name: part.name, summary: summary(part) }];
    case "reasoning":
      return [];
  }
};
