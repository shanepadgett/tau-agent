/**
 * Print mode: `tau -p "prompt"` runs one prompt, streams the answer to stdout and reports tool
 * calls and the session ID on stderr, so `tau -p ... > answer.md` keeps only the answer.
 */

import { Console, Effect, Option, PubSub, Stdio, Stream } from "effect";
import { type AgentEvent, type RunOptions, runEndMessage } from "../../core/Client.ts";
import { openSession, printSessionId } from "./agent-session.ts";
import { showFailure } from "./failure.ts";

/** Runs `prompt`, or the text on stdin when there is none. */
export const printPrompt = Effect.fn("printPrompt")(function* (
  session: Option.Option<string>,
  prompt: Option.Option<string>,
  options: RunOptions,
) {
  const text = Option.isSome(prompt) ? prompt.value : yield* readStdin;
  yield* printRun(session, text, options);
});

const readStdin = Stdio.Stdio.use((stdio) =>
  stdio.stdin.pipe(Stream.decodeText(), Stream.mkString),
);

const printRun = Effect.fn("printRun")(function* (
  session: Option.Option<string>,
  prompt: string,
  options: RunOptions,
) {
  const opened = yield* openSession(session);
  const events = yield* opened.subscribe;
  yield* opened.send({ type: "prompt", text: prompt, options });

  const end = yield* printEvents(events).pipe(
    Effect.onInterrupt(() => opened.send({ type: "cancel" })),
  );

  yield* printSessionId(opened.session.id);
  const message = runEndMessage(end);
  if (message !== undefined) return yield* showFailure({ message });
}, Effect.scoped);

type RunEnded = Extract<AgentEvent, { type: "run-ended" }>;

const printEvents = Effect.fn("printEvents")(function* (events: PubSub.Subscription<AgentEvent>) {
  const stdio = yield* Stdio.Stdio;

  for (;;) {
    const event = yield* PubSub.take(events);
    const end = yield* printEvent(stdio, event);
    if (Option.isSome(end)) return end.value;
  }
});

/** The answer goes to stdout; everything else goes to stderr, so `> answer.md` keeps only the answer. */
const printEvent = (stdio: Stdio.Stdio, event: AgentEvent) => {
  switch (event.type) {
    case "text":
      return Stream.make(event.delta).pipe(
        Stream.run(stdio.stdout({ endOnDone: false })),
        Effect.as(Option.none<RunEnded>()),
      );
    case "tool-started":
      return Console.error(`\n› ${event.summary}`).pipe(Effect.as(Option.none<RunEnded>()));
    case "retrying":
      return Console.error(
        `\n${event.message}\nRetry ${event.attempt} in ${event.seconds} s.`,
      ).pipe(Effect.as(Option.none<RunEnded>()));
    case "run-started":
    case "tool-ended":
    case "prompts-returned":
    case "checks-started":
    case "checks-ended":
    case "steered":
    case "model-call-ended":
    case "processes-changed":
    case "notes-written":
    case "references-changed":
      return Effect.succeed(Option.none<RunEnded>());
    case "run-ended":
      return Effect.succeed(Option.some(event));
  }
};
