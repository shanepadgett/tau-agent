/**
 * Print mode: `tau -p "prompt"` runs one prompt, streams the answer to stdout and reports tool
 * calls and the session ID on stderr, so `tau -p ... > answer.md` keeps only the answer.
 */

import { Console, Duration, Effect, Layer, Option, PubSub, Schema, Stdio, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { Catalog, parseModelRef } from "../../ai/Catalog.ts";
import { Models } from "../../ai/Models.ts";
import { Agent } from "../../core/Agent.ts";
import { ContextMethod } from "../../core/ContextMethod.ts";
import type { AgentEvent, RunOptions } from "../../core/Client.ts";
import { type RunSettings, Settings } from "../../host/Settings.ts";
import { userInstructionsLayer } from "../../host/UserInstructions.ts";
import { SessionId } from "../../session/Entry.ts";
import { Sessions } from "../../session/Sessions.ts";
import { showFailure } from "./failure.ts";

const DEFAULT_RUN_MINUTES = 10;
const DEFAULT_SHELL_MINUTES = 2;
const DEFAULT_RUN_TIMEOUT = Duration.minutes(DEFAULT_RUN_MINUTES);
const DEFAULT_SHELL_TIMEOUT = Duration.minutes(DEFAULT_SHELL_MINUTES);

class NoModel extends Schema.TaggedError<NoModel>()("NoModel", { message: Schema.String }) {}

const config = {
  print: Flag.Boolean("print").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Run one prompt and print the answer."),
  ),
  session: Flag.String("session").pipe(
    Flag.optional,
    Flag.withDescription("Continue the session with this ID."),
  ),
  model: Flag.String("model").pipe(
    Flag.optional,
    Flag.withDescription("The model to use, as route/model."),
  ),
  prompt: Argument.String("prompt").pipe(
    Argument.optional,
    Argument.withDescription("The prompt. Without it, Tau reads the prompt from stdin."),
  ),
};

/** The agent with everything it needs: the models of the catalog, and the session store. */
const agentLayer = Agent.layer.pipe(
  Layer.provideMerge(ContextMethod.layer),
  Layer.provideMerge(Models.layer),
  Layer.provideMerge(Catalog.layer),
  Layer.provide(Sessions.layer),
  Layer.provide(userInstructionsLayer),
);

/** The `tau` command itself. Without a subcommand, `-p` runs a prompt. */
export const rootCommand = Command.make(
  "tau",
  config,
  Effect.fn("tau")(function* (input) {
    if (!input.print) {
      return yield* Console.log(
        'The interactive mode is not built yet. Run a prompt with tau -p "prompt".',
      );
    }

    const { run } = yield* Settings;
    const options = yield* runOptions(input.model, run);
    const prompt = Option.isSome(input.prompt) ? input.prompt.value : yield* readStdin;
    const session = Option.map(input.session, (id) => SessionId.make(id));
    yield* printRun(session, prompt, options).pipe(Effect.provide(agentLayer));
  }),
);

const runOptions = Effect.fn("runOptions")(function* (
  flag: Option.Option<string>,
  settings: RunSettings,
) {
  const text = Option.getOrUndefined(
    Option.orElse(flag, () => Option.fromUndefinedOr(settings.model)),
  );

  if (text === undefined) {
    return yield* new NoModel({
      message:
        'No model is set. Add "model": "route/model" to ~/.tau/settings.json, such as "anthropic/claude-sonnet-5-5", or pass --model.',
    });
  }

  const model = parseModelRef(text);

  if (Option.isNone(model)) {
    return yield* new NoModel({
      message: `"${text}" is not a model. Write it as route/model, such as anthropic/claude-sonnet-5-5.`,
    });
  }

  return {
    model: model.value,
    maxTurns: settings.maxTurns,
    timeouts: {
      run: secondsOr(settings.runTimeoutSeconds, DEFAULT_RUN_TIMEOUT),
      shell: secondsOr(settings.shellTimeoutSeconds, DEFAULT_SHELL_TIMEOUT),
    },
  } satisfies RunOptions;
});

const secondsOr = (seconds: number | undefined, fallback: Duration.Duration) =>
  seconds === undefined ? fallback : Duration.seconds(seconds);

const readStdin = Stdio.Stdio.use((stdio) =>
  stdio.stdin.pipe(Stream.decodeText(), Stream.mkString),
);

const printRun = Effect.fn("printRun")(function* (
  id: Option.Option<SessionId>,
  prompt: string,
  options: RunOptions,
) {
  yield* Effect.forkScoped((yield* Catalog).refreshIfStale);

  const opened = yield* (yield* Agent)
    .open(id, process.cwd())
    .pipe(
      Effect.catchTag("SessionNotFound", (error) =>
        showFailure({ message: `There is no session ${error.session}.` }),
      ),
    );

  const events = yield* opened.subscribe;
  yield* opened.send({ type: "prompt", text: prompt, options });

  const end = yield* printEvents(events).pipe(
    Effect.onInterrupt(() => opened.send({ type: "cancel" })),
  );

  yield* Console.error(`\nSession: ${opened.session.id}`);

  if (end.reason === "failed")
    return yield* showFailure({ message: `The run failed: ${end.error}` });

  if (end.reason === "turn-limit") {
    return yield* showFailure({ message: "The run reached maxTurns in ~/.tau/settings.json." });
  }

  if (end.reason === "output-limit") {
    return yield* showFailure({
      message: "The reply reached the model's output limit, so the answer is cut short.",
    });
  }

  if (end.reason === "repeated-call") {
    return yield* showFailure({
      message: `The model sent the same failing call again and again, so Tau stopped the run: ${end.call}`,
    });
  }

  if (end.reason === "checks-failed") {
    return yield* showFailure({
      message: `The project's checks still fail after the model's tries to fix them: ${end.checks.join(", ")}.`,
    });
  }
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
    case "tool-ended":
    case "prompts-returned":
    case "checks-started":
    case "checks-ended":
      return Effect.succeed(Option.none<RunEnded>());
    case "run-ended":
      return Effect.succeed(Option.some(event));
  }
};
