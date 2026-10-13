/**
 * Calls the model when it answers next, streams its text to clients, and saves the reply. A reply
 * cut short by a cancel is saved as interrupted.
 */

import { Chunk, Effect, Option, Ref, Stream } from "effect";
import { Prompt, type Response } from "effect/ai";
import type { Entry } from "../../../session/Entry.ts";
import { contextView } from "../../../session/ContextView.ts";
import { runToolkit } from "../run-tool/run-tool.ts";
import { BASE_PROMPT } from "../run-tool/soul.ts";
import { interruptedEntry, replyEntry } from "./reply.ts";
import { CONTINUE, type Operation, type Outcome, type RunContext } from "./run-context.ts";
import { needsReply } from "./tool-history.ts";

const ANSWERED: Outcome = { type: "end", reason: "answered" };

export const callModel =
  <R>(run: RunContext<R>): Operation<R> =>
  (entries) =>
    needsReply(entries) ? Option.some(reply(run, entries)) : Option.none();

const reply = Effect.fn("reply")(function* <R>(run: RunContext<R>, entries: readonly Entry[]) {
  const received = yield* Ref.make(Chunk.empty<Response.AnyPart>());

  const stream = run.languageModel.streamText({
    prompt: Prompt.setSystem(contextView(entries), BASE_PROMPT),
    toolkit: runToolkit(run.functions, run.timeouts),
    disableToolCallResolution: true,
  });

  yield* Stream.runForEach(stream, (part) =>
    Ref.update(received, Chunk.append(part)).pipe(
      Effect.andThen(
        part.type === "text-delta" ? run.emit({ type: "text", delta: part.delta }) : Effect.void,
      ),
    ),
  ).pipe(
    Effect.onInterrupt(() =>
      Ref.get(received).pipe(Effect.flatMap((parts) => saveInterruptedReply(run, parts))),
    ),
  );

  const body = yield* replyEntry(run.model, Chunk.toReadonlyArray(yield* Ref.get(received)));
  yield* run.sessions.append(run.session, [body]);

  const callsTools = body.parts.some((part) => part.type === "tool-call");
  return callsTools ? CONTINUE : ANSWERED;
});

const saveInterruptedReply = <R>(run: RunContext<R>, parts: Chunk.Chunk<Response.AnyPart>) => {
  const body = interruptedEntry(run.model, Chunk.toReadonlyArray(parts));
  if (body === undefined) return Effect.void;
  return run.sessions.append(run.session, [body]).pipe(Effect.ignore({ log: true }));
};
