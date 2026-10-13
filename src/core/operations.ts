/**
 * The operations a step tries, in order. Each looks at the session's entries and either passes or
 * acts. An operation keeps nothing in memory: what it did is in the entries it saves.
 */

import { Effect, Option, Predicate, Stream } from "effect";
import { type AiError, type LanguageModel, Prompt, type Response } from "effect/ai";
import type { ModelRef } from "../ai/catalog.ts";
import type { Functions } from "../sandbox/sandbox.ts";
import { contextView } from "../session/context-view.ts";
import type { Entry, EntryBody, SessionId } from "../session/entry.ts";
import type { SessionNotFound, Sessions, SessionStoreError } from "../session/sessions.ts";
import { BASE_PROMPT } from "./base-prompt.ts";
import type { AgentEvent } from "./client.ts";
import { interruptedEntry, replyEntry } from "./reply.ts";
import { runCall, runToolkit, type Timeouts } from "./run-tool.ts";

export type Outcome =
  | { readonly type: "continue" }
  | { readonly type: "end"; readonly reason: "answered" | "turn-limit" };

/** Everything the operations of one run share. */
export type RunContext<R> = {
  readonly session: SessionId;
  readonly model: ModelRef;
  readonly languageModel: LanguageModel.LanguageModel;
  readonly sessions: Sessions["Service"];
  readonly functions: Functions<R>;
  readonly timeouts: Timeouts;
  readonly maxTurns: number | undefined;
  readonly emit: (event: AgentEvent) => Effect.Effect<void>;
};

type RunError = SessionNotFound | SessionStoreError | AiError.AiError;

/** Passes with none, or gives the action to take for these entries. */
type Operation<R> = (
  entries: readonly Entry[],
) => Option.Option<Effect.Effect<Outcome, RunError, R>>;

type AssistantPart = Extract<EntryBody, { type: "assistant" }>["parts"][number];
type ToolCall = Extract<AssistantPart, { type: "tool-call" }>;

const CONTINUE: Outcome = { type: "continue" };
const TURN_LIMIT: Outcome = { type: "end", reason: "turn-limit" };
const ANSWERED: Outcome = { type: "end", reason: "answered" };
const INTERRUPTED_BY_CRASH = "Interrupted before it finished. It did not run again.";
const INTERRUPTED_BY_USER = "Interrupted by the user.";

/** The operations in the order a step tries them. Calling the model is always last. */
export const operations = <R>(run: RunContext<R>): ReadonlyArray<Operation<R>> => [
  interruptStartedCalls(run),
  runToolCalls(run),
  stopAtTurnLimit(run),
  callModel(run),
];

/**
 * A call that started and has no result was cut short by a crash. Running it again could repeat
 * its effects, so it gets a result that says so.
 */
const interruptStartedCalls =
  <R>(run: RunContext<R>): Operation<R> =>
  (entries) => {
    const answered = resultIds(entries);
    const started = startedIds(entries);

    const cutShort = allCalls(entries).filter(
      (call) => started.has(call.id) && !answered.has(call.id),
    );

    if (cutShort.length === 0) return Option.none();

    const interruptedResults = cutShort.map((call) => failedResult(call, INTERRUPTED_BY_CRASH));
    const save = run.sessions.append(run.session, interruptedResults);
    return Option.some(save.pipe(Effect.as(CONTINUE)));
  };

const runToolCalls =
  <R>(run: RunContext<R>): Operation<R> =>
  (entries) => {
    const calls = openCalls(entries);
    if (calls.length === 0) return Option.none();

    const runAll = Effect.forEach(calls, (call) => runToolCall(run, call));
    return Option.some(runAll.pipe(Effect.as(CONTINUE)));
  };

/**
 * Saves the call as started, runs it and saves its result. A cancel at any point after the start
 * gives the call a result that says so.
 */
const runToolCall = <R>(run: RunContext<R>, call: ToolCall) => {
  const execute = Effect.gen(function* () {
    yield* run.sessions.append(run.session, [{ type: "tool-started", callId: call.id }]);
    yield* run.emit({ type: "tool-started", callId: call.id, summary: summary(call) });

    const scriptResult =
      call.name === "run"
        ? yield* runCall(call.params, run.functions, run.timeouts)
        : { text: `There is no tool named ${call.name}. The only tool is run.`, isFailure: true };

    yield* run.sessions.append(run.session, [
      {
        type: "tool-result",
        callId: call.id,
        name: call.name,
        result: scriptResult.text,
        isFailure: scriptResult.isFailure,
      },
    ]);

    yield* run.emit({ type: "tool-ended", callId: call.id, isFailure: scriptResult.isFailure });
  });

  const saveInterrupted = run.sessions
    .append(run.session, [failedResult(call, INTERRUPTED_BY_USER)])
    .pipe(Effect.ignore);

  return execute.pipe(Effect.onInterrupt(() => saveInterrupted));
};

const stopAtTurnLimit =
  <R>(run: RunContext<R>): Operation<R> =>
  (entries) => {
    if (run.maxTurns === undefined || !needsReply(entries)) return Option.none();
    if (turnsSincePrompt(entries) < run.maxTurns) return Option.none();
    return Option.some(Effect.succeed(TURN_LIMIT));
  };

const callModel =
  <R>(run: RunContext<R>): Operation<R> =>
  (entries) =>
    needsReply(entries) ? Option.some(reply(run, entries)) : Option.none();

const reply = Effect.fn("reply")(function* <R>(run: RunContext<R>, entries: readonly Entry[]) {
  const parts: Response.AnyPart[] = [];

  const stream = run.languageModel.streamText({
    prompt: Prompt.setSystem(contextView(entries), BASE_PROMPT),
    toolkit: runToolkit(run.functions, run.timeouts),
    disableToolCallResolution: true,
  });

  yield* Stream.runForEach(stream, (part) => {
    parts.push(part);
    return part.type === "text-delta" ? run.emit({ type: "text", delta: part.delta }) : Effect.void;
  }).pipe(Effect.onInterrupt(() => saveInterruptedReply(run, parts)));

  const body = yield* replyEntry(run.model, parts);
  yield* run.sessions.append(run.session, [body]);

  const callsTools = body.parts.some((part) => part.type === "tool-call");
  return callsTools ? CONTINUE : ANSWERED;
});

const saveInterruptedReply = <R>(run: RunContext<R>, parts: readonly Response.AnyPart[]) => {
  const body = interruptedEntry(run.model, parts);
  if (body === undefined) return Effect.void;
  return run.sessions.append(run.session, [body]).pipe(Effect.ignore);
};

const failedResult = (call: ToolCall, text: string): EntryBody => ({
  type: "tool-result",
  callId: call.id,
  name: call.name,
  result: text,
  isFailure: true,
});

const resultIds = (entries: readonly Entry[]) =>
  new Set(entries.flatMap(({ body }) => (body.type === "tool-result" ? [body.callId] : [])));

const startedIds = (entries: readonly Entry[]) =>
  new Set(entries.flatMap(({ body }) => (body.type === "tool-started" ? [body.callId] : [])));

const callsOf = (parts: readonly AssistantPart[]) =>
  parts.filter((part): part is ToolCall => part.type === "tool-call");

const allCalls = (entries: readonly Entry[]) =>
  entries.flatMap(({ body }) => (body.type === "assistant" ? callsOf(body.parts) : []));

/**
 * The calls of the latest reply that have not started. A prompt after that reply means the user
 * moved on, so its calls stay unrun.
 */
const openCalls = (entries: readonly Entry[]) => {
  const latest = entries.findLast(
    ({ body }) => body.type === "user" || (body.type === "assistant" && !body.interrupted),
  );

  if (latest?.body.type !== "assistant") return [];

  const handled = new Set([...resultIds(entries), ...startedIds(entries)]);
  return callsOf(latest.body.parts).filter((call) => !handled.has(call.id));
};

/** The model answers next when the session ends with a prompt or a tool result. */
const needsReply = (entries: readonly Entry[]) => {
  const last = entries.findLast(({ body }) => body.type !== "tool-started");
  return last?.body.type === "user" || last?.body.type === "tool-result";
};

const turnsSincePrompt = (entries: readonly Entry[]) => {
  const prompt = entries.findLastIndex(({ body }) => body.type === "user");
  return entries.slice(prompt + 1).filter(({ body }) => body.type === "assistant").length;
};

/** The first line of the script, so a client can show what is running. */
const summary = (call: ToolCall) => {
  const code = Predicate.hasProperty(call.params, "code") ? call.params.code : undefined;
  return Predicate.isString(code) ? (code.trim().split("\n")[0] ?? "") : call.name;
};
