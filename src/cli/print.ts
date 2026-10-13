/**
 * Print mode: `tau -p "prompt"` runs one prompt, streams the answer to stdout and reports tool
 * calls and the session ID on stderr, so `tau -p ... > answer.md` keeps only the answer.
 */

import { Console, Duration, Effect, Layer, Option, PubSub, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { Catalog, catalogLayer, parseModelRef, publicCatalogSources } from "../ai/catalog.ts";
import { modelsLayer } from "../ai/models.ts";
import { Agent, agentLayer, type RunOptions } from "../core/agent.ts";
import type { AgentEvent } from "../core/client.ts";
import { catalogCacheLayer } from "../host/catalog-cache.ts";
import { readSettings, type RunSettings } from "../host/settings.ts";
import { SessionId } from "../session/entry.ts";
import { sessionsLayer } from "../session/sessions.ts";
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

/** The `tau` command itself. Without a subcommand, `-p` runs a prompt. */
export const rootCommand = (tauDirectory: string) =>
  Command.make(
    "tau",
    config,
    Effect.fn("tau")(function* (input) {
      if (!input.print) {
        return yield* Console.log(
          'The interactive mode is not built yet. Run a prompt with tau -p "prompt".',
        );
      }

      const settings = yield* readSettings(tauDirectory);
      const options = yield* runOptions(input.model, settings.run);
      const prompt = Option.isSome(input.prompt) ? input.prompt.value : yield* readStdin;

      const catalog = catalogLayer({
        routes: settings.routes,
        settings: settings.routeSettings,
        sources: publicCatalogSources,
      }).pipe(Layer.provide(catalogCacheLayer(tauDirectory)));

      const layer = agentLayer.pipe(
        Layer.provideMerge(modelsLayer),
        Layer.provideMerge(catalog),
        Layer.provide(sessionsLayer(tauDirectory)),
      );

      const session = Option.map(input.session, (id) => SessionId.make(id));
      yield* printRun(session, prompt, options).pipe(Effect.provide(layer));
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

const readStdin = Effect.promise(() => Bun.stdin.text());

const printRun = Effect.fn("printRun")(function* (
  id: Option.Option<SessionId>,
  prompt: string,
  options: RunOptions,
) {
  const agent = yield* Agent;
  yield* Effect.forkScoped((yield* Catalog).refreshIfStale);

  const session = yield* agent
    .open(id, process.cwd(), options)
    .pipe(
      Effect.catchTag("SessionNotFound", (error) =>
        showFailure({ message: `There is no session ${error.session}.` }),
      ),
    );

  const events = yield* agent.subscribe(session.id);
  yield* agent.send(session.id, { type: "prompt", text: prompt });

  const end = yield* printEvents(events).pipe(
    Effect.onInterrupt(() => agent.send(session.id, { type: "cancel" })),
  );

  yield* Console.error(`\nSession: ${session.id}`);

  if (end.reason === "failed")
    return yield* showFailure({ message: `The run failed: ${end.error ?? "no reason given"}` });

  if (end.reason === "turn-limit") {
    return yield* showFailure({ message: "The run reached maxTurns in ~/.tau/settings.json." });
  }
}, Effect.scoped);

type RunEnded = Extract<AgentEvent, { type: "run-ended" }>;

const printEvents = Effect.fn("printEvents")(function* (events: PubSub.Subscription<AgentEvent>) {
  for (;;) {
    const event = yield* PubSub.take(events);
    const end = yield* printEvent(event);
    if (Option.isSome(end)) return end.value;
  }
});

const printEvent = (event: AgentEvent): Effect.Effect<Option.Option<RunEnded>> => {
  switch (event.type) {
    case "text":
      return Effect.sync(() => process.stdout.write(event.delta)).pipe(Effect.as(Option.none()));
    case "tool-started":
      return Console.error(`\n› ${event.summary}`).pipe(Effect.as(Option.none()));
    case "tool-ended":
      return Effect.succeed(Option.none());
    case "run-ended":
      return Effect.succeed(Option.some(event));
  }
};
