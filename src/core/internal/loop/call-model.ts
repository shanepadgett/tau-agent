/**
 * Calls the model when it answers next, streams its text to clients, and saves the reply. A reply
 * cut short by a cancel or an error is saved as interrupted. Errors that can pass are retried.
 */

import { Chunk, Effect, Option, Ref, Stream } from "effect";
import { AiError, type Response } from "effect/ai";
import type { Entry } from "../../../session/Entry.ts";
import { BASE_PROMPT } from "../run-tool/soul.ts";
import { toolkit } from "../tools/model-tool.ts";
import { interruptedEntry, modelCall, replyEntry } from "./reply.ts";
import { retrySchedule } from "./retry.ts";
import { CONTINUE, endWith, type Operation, type RunContext } from "./run-context.ts";

const OUTPUT_LIMIT = endWith({ reason: "output-limit" });

/**
 * Some models sometimes end a reply with no text and no tool call. Taken as the answer, it would end
 * the run with the work not done, so it fails as invalid output, which is tried again.
 */
const EMPTY_REPLY = AiError.make({
  module: "Agent",
  method: "reply",
  reason: new AiError.InvalidOutputError({
    description: "The model sent an empty reply, with no text and no tool call.",
  }),
});

export const callModel =
  <R>(run: RunContext<R>): Operation<R> =>
  (entries) =>
    run.shouldReply(entries) ? Option.some(reply(run, entries)) : Option.none();

const reply = Effect.fn("reply")(function* <R>(run: RunContext<R>, saved: readonly Entry[]) {
  const instructed = yield* withInstructions(run, saved);
  const noticed = yield* withNotices(run, instructed);
  const steered = yield* withSteering(run, noticed);
  const nudge = run.nudge(steered);

  const entries = Option.isSome(nudge)
    ? [...steered, ...(yield* run.sessions.append(run.session, [nudge.value]))]
    : steered;

  const parts = yield* streamReply(run, entries).pipe(Effect.retry(retrySchedule(run.emit)));

  const body = yield* replyEntry(run.model, parts);
  yield* run.sessions.append(run.session, [body]);

  if (body.tokens !== undefined)
    yield* run.emit({
      type: "model-call-ended",
      call: modelCall(run.model, run.profile, body.tokens),
    });

  // A reply cut off at the output limit can end in the middle of a tool call.
  const finish = parts.find((part) => part.type === "finish");
  // A reply without tool calls is the answer only once no later operation applies, such as checks.
  return finish?.reason === "length" ? OUTPUT_LIMIT : CONTINUE;
});

/** One attempt: streams the reply and gives its parts. */
const streamReply = Effect.fn("streamReply")(function* <R>(
  run: RunContext<R>,
  entries: readonly Entry[],
) {
  const received = yield* Ref.make(Chunk.empty<Response.AnyPart>());

  const stream = run.languageModel.streamText({
    prompt: yield* run.view(BASE_PROMPT, entries),
    toolkit: toolkit(run.tools),
    disableToolCallResolution: true,
  });

  yield* Stream.runForEach(stream, (part) =>
    Ref.update(received, Chunk.append(part)).pipe(
      Effect.andThen(
        part.type === "text-delta" ? run.emit({ type: "text", delta: part.delta }) : Effect.void,
      ),
    ),
  ).pipe(
    Effect.onError(() =>
      Ref.get(received).pipe(Effect.flatMap((parts) => saveInterruptedReply(run, parts))),
    ),
  );

  const parts = Chunk.toReadonlyArray(yield* Ref.get(received));
  if (isEmptyReply(parts)) return yield* EMPTY_REPLY;

  return parts;
});

const isEmptyReply = (parts: readonly Response.AnyPart[]) =>
  !parts.some(
    (part) => part.type === "tool-call" || (part.type === "text-delta" && part.delta.trim() !== ""),
  );

/** Saves what changed in the instructions since the last model call, and gives the entries with it. */
const withInstructions = Effect.fn("withInstructions")(function* <R>(
  run: RunContext<R>,
  entries: readonly Entry[],
) {
  const update = yield* run.updateInstructions(entries);
  if (Option.isNone(update)) return entries;

  return [...entries, ...(yield* run.sessions.append(run.session, [update.value]))];
});

/** Saves the notices that arrived since the last model call, and gives the entries with them. */
const withNotices = Effect.fn("withNotices")(function* <R>(
  run: RunContext<R>,
  entries: readonly Entry[],
) {
  const notices = yield* run.processNotices;
  if (notices.length === 0) return entries;

  return [...entries, ...(yield* run.sessions.append(run.session, notices))];
});

/**
 * Saves the steering messages that arrived since the last model call as user entries, tells clients
 * they reached the run, and gives the entries with them.
 */
export const withSteering = Effect.fn("withSteering")(function* <R>(
  run: RunContext<R>,
  entries: readonly Entry[],
) {
  const messages = yield* run.takeSteering;
  if (messages.length === 0) return entries;

  const bodies = yield* Effect.forEach(messages, ({ text, images }) =>
    run.withListings({
      type: "user",
      text,
      steering: true,
      images: images.length > 0 ? images : undefined,
    }),
  );

  const saved = yield* run.sessions.append(run.session, bodies.flat());
  yield* Effect.forEach(messages, ({ text }) => run.emit({ type: "steered", text }));

  return [...entries, ...saved];
});

const saveInterruptedReply = <R>(run: RunContext<R>, parts: Chunk.Chunk<Response.AnyPart>) => {
  const body = interruptedEntry(run.model, Chunk.toReadonlyArray(parts));
  if (body === undefined) return Effect.void;
  return run.sessions.append(run.session, [body]).pipe(Effect.ignore({ log: true }));
};
