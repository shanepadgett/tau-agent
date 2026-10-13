/**
 * Calls the model when it answers next, streams its text to clients, and saves the reply. A reply
 * cut short by a cancel or an error is saved as interrupted. Errors that can pass are retried.
 */

import { Chunk, Effect, Option, Ref, Stream } from "effect";
import type { Response } from "effect/ai";
import type { Entry } from "../../../session/Entry.ts";
import { contextView } from "../../../session/ContextView.ts";
import { runToolkit } from "../run-tool/run-tool.ts";
import { BASE_PROMPT } from "../run-tool/soul.ts";
import { interruptedEntry, replyEntry } from "./reply.ts";
import { retrySchedule } from "./retry.ts";
import { CONTINUE, type Operation, type Outcome, type RunContext } from "./run-context.ts";
import { needsReply } from "./tool-history.ts";

const ANSWERED: Outcome = { type: "end", reason: "answered" };
const OUTPUT_LIMIT: Outcome = { type: "end", reason: "output-limit" };

export const callModel =
  <R>(run: RunContext<R>): Operation<R> =>
  (entries) =>
    needsReply(entries) ? Option.some(reply(run, entries)) : Option.none();

const reply = Effect.fn("reply")(function* <R>(run: RunContext<R>, saved: readonly Entry[]) {
  const entries = yield* withInstructions(run, saved);
  const parts = yield* streamReply(run, entries).pipe(Effect.retry(retrySchedule(run.emit)));

  const body = yield* replyEntry(run.model, parts);
  yield* run.sessions.append(run.session, [body]);

  // A reply cut off at the output limit can end in the middle of a tool call.
  const finish = parts.find((part) => part.type === "finish");
  if (finish?.reason === "length") return OUTPUT_LIMIT;

  const callsTools = body.parts.some((part) => part.type === "tool-call");
  return callsTools ? CONTINUE : ANSWERED;
});

/** One attempt: streams the reply and gives its parts. */
const streamReply = Effect.fn("streamReply")(function* <R>(
  run: RunContext<R>,
  entries: readonly Entry[],
) {
  const received = yield* Ref.make(Chunk.empty<Response.AnyPart>());

  const stream = run.languageModel.streamText({
    prompt: contextView(BASE_PROMPT, entries),
    toolkit: runToolkit(
      run.functions(() => Effect.void),
      run.timeouts,
    ),
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

  return Chunk.toReadonlyArray(yield* Ref.get(received));
});

/** Saves what changed in the instructions since the last model call, and gives the entries with it. */
const withInstructions = Effect.fn("withInstructions")(function* <R>(
  run: RunContext<R>,
  entries: readonly Entry[],
) {
  const update = yield* run.updateInstructions(entries);
  if (Option.isNone(update)) return entries;

  return [...entries, ...(yield* run.sessions.append(run.session, [update.value]))];
});

const saveInterruptedReply = <R>(run: RunContext<R>, parts: Chunk.Chunk<Response.AnyPart>) => {
  const body = interruptedEntry(run.model, Chunk.toReadonlyArray(parts));
  if (body === undefined) return Effect.void;
  return run.sessions.append(run.session, [body]).pipe(Effect.ignore({ log: true }));
};
