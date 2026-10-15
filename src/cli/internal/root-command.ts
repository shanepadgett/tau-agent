/**
 * The `tau` command itself: with `-p` it runs one prompt in print mode; without it, it opens the
 * chat in the terminal under a supervisor, which restarts the chat into new code.
 */

import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { Settings } from "../../host/Settings.ts";
import { ReloadLink } from "../../supervisor/ReloadLink.ts";
import { superviseChat } from "../../supervisor/Supervisor.ts";
import { agentLayer } from "./agent-session.ts";
import { printPrompt } from "./print.ts";
import { requireModel, runOptions } from "./run-options.ts";
import { chatArgs, runSupervisedChat, supervisorLayer } from "./supervised-chat.ts";

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
    Flag.withDescription("The model to use, as provider/model."),
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
    const settings = yield* Settings;
    const options = yield* runOptions(input.model, settings.run);

    if (input.print) {
      return yield* printPrompt(input.session, input.prompt, yield* requireModel(options)).pipe(
        Effect.provide(agentLayer),
      );
    }

    const link = yield* ReloadLink;
    if (link.kind === "supervised") return yield* runSupervisedChat(link, input, options);

    // Ctrl-C reaches the supervisor too. The chat decides what it does, so the supervisor waits for
    // the chat to end.
    yield* superviseChat({
      argsFor: chatArgs(input),
      mode: settings.autoRestart ? "automatic" : "manual",
    }).pipe(Effect.provide(supervisorLayer), Effect.uninterruptible);
  }),
);
