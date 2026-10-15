/** Resolves how runs behave, from the command line and the user's settings: the model and the timeouts. */

import { Duration, Effect, Option, Schema } from "effect";
import { parseModelRef } from "../../ai/Catalog.ts";
import type { RunOptions } from "../../core/Client.ts";
import type { RunSettings } from "../../host/Settings.ts";
import type { ChatOptions } from "../../tui/Tui.ts";

const DEFAULT_RUN_MINUTES = 10;
const DEFAULT_SHELL_MINUTES = 2;
const DEFAULT_RUN_TIMEOUT = Duration.minutes(DEFAULT_RUN_MINUTES);
const DEFAULT_SHELL_TIMEOUT = Duration.minutes(DEFAULT_SHELL_MINUTES);
/** A new chat and print mode think at this level until the user picks another. */
const DEFAULT_THINKING = "medium";

class NoModel extends Schema.TaggedError<NoModel>()("NoModel", { message: Schema.String }) {}

/**
 * The `--model` flag wins over the model in the settings. The model is undefined when neither sets
 * one: the chat opens without it, and print mode needs one (see `requireModel`).
 */
export const runOptions = Effect.fn("runOptions")(function* (
  flag: Option.Option<string>,
  settings: RunSettings,
) {
  const text = Option.getOrUndefined(
    Option.orElse(flag, () => Option.fromUndefinedOr(settings.model)),
  );

  return {
    model: text === undefined ? undefined : yield* modelRef(text),
    thinking: DEFAULT_THINKING,
    maxTurns: settings.maxTurns,
    timeouts: {
      run: secondsOr(settings.runTimeoutSeconds, DEFAULT_RUN_TIMEOUT),
      shell: secondsOr(settings.shellTimeoutSeconds, DEFAULT_SHELL_TIMEOUT),
    },
  } satisfies ChatOptions;
});

/** Print mode cannot ask for a model, so it stops when none is set. */
export const requireModel = (options: ChatOptions): Effect.Effect<RunOptions, NoModel> => {
  const { model } = options;

  if (model === undefined) {
    return Effect.fail(
      new NoModel({
        message:
          'No model is set. Add "model": "provider/model" to ~/.tau/settings.json, such as "anthropic/claude-sonnet-5-5", or pass --model.',
      }),
    );
  }

  return Effect.succeed({ ...options, model });
};

const modelRef = (text: string) =>
  Option.match(parseModelRef(text), {
    onNone: () =>
      Effect.fail(
        new NoModel({
          message: `"${text}" is not a model. Write it as provider/model, such as anthropic/claude-sonnet-5-5.`,
        }),
      ),
    onSome: Effect.succeed,
  });

const secondsOr = (seconds: number | undefined, fallback: Duration.Duration) =>
  seconds === undefined ? fallback : Duration.seconds(seconds);
