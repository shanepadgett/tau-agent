/**
 * The `tau` command itself: with `-p` it runs one prompt in print mode; without it, it opens the
 * chat in the terminal.
 */

import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { Settings } from "../../host/Settings.ts";
import type { ChatOptions } from "../../tui/Tui.ts";
import { agentLayer, openSession } from "./agent-session.ts";
import { printPrompt } from "./print.ts";
import { requireModel, runOptions } from "./run-options.ts";

const config = {
  print: Flag.Boolean("print").pipe(
    Flag.withAlias("p"),
    Flag.withDefault(false),
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
    Argument.withDescription(
      "The prompt. With -p and no prompt, Tau reads it from stdin. Without -p, the chat sends it first.",
    ),
  ),
};

export const rootCommand = Command.make(
  "tau",
  config,
  Effect.fn("tau")(function* (input) {
    const { run } = yield* Settings;
    const options = yield* runOptions(input.model, run);

    if (input.print) {
      return yield* printPrompt(input.session, input.prompt, yield* requireModel(options));
    }

    const session = yield* chat(input.session, input.prompt, options);
    yield* Console.error(`Session: ${session}`);
  }, Effect.provide(agentLayer)),
);

/** Returns the session ID after the user quits, so the user can continue it with `--session`. */
const chat = Effect.fn("chat")(function* (
  session: Option.Option<string>,
  prompt: Option.Option<string>,
  options: ChatOptions,
) {
  const opened = yield* openSession(session);
  // Solid's JSX transform must be in place before the TUI's .tsx files load. `bunfig.toml` adds it
  // only when Bun starts in this repository, and Tau runs in other folders too.
  // `ensureSolidTransformPlugin` is what `@opentui/solid/preload` runs; that module has no types.
  const solid = yield* Effect.promise(() => import("@opentui/solid/bun-plugin"));
  solid.ensureSolidTransformPlugin();

  const chatInTerminal = yield* Effect.promise(() =>
    import("../../tui/Tui.ts").then((tui) => tui.chatInTerminal),
  );

  yield* chatInTerminal(opened, options, prompt);
  return opened.session.id;
}, Effect.scoped);
