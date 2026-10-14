/**
 * The chat in the terminal, which `tau` opens when `-p` is not given. Import it lazily: it loads
 * OpenTUI's native renderer, which print mode does not need.
 */

import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { Effect, Option } from "effect";
import type { OpenSession } from "../core/Agent.ts";
import { showChat } from "./internal/App.tsx";
import { type ChatOptions, chatClient } from "./internal/chat-client.ts";

/**
 * Takes over the terminal for the chat. Closing the scope gives the terminal back as it was. The
 * kitty keyboard protocol lets Tau tell Shift-Enter and Ctrl-Enter from Enter.
 */
const openTerminal = Effect.acquireRelease(
  Effect.promise(() => createCliRenderer({ exitOnCtrlC: false, useKittyKeyboard: {} })),
  (renderer) =>
    Effect.sync(() => {
      renderer.destroy();
    }),
);

export type { ChatOptions } from "./internal/chat-client.ts";

/** Shows the chat of `opened` in the terminal until the user quits. `prompt`, when given, is sent first. */
export const chatInTerminal = Effect.fn("chatInTerminal")(function* (
  opened: OpenSession,
  options: ChatOptions,
  prompt: Option.Option<string>,
) {
  const renderer = yield* openTerminal;
  yield* runTui(renderer, opened, options, prompt);
}, Effect.scoped);

/** Shows the chat of `opened` on `renderer` until the user quits. `prompt`, when given, is sent first. */
export const runTui = Effect.fn("runTui")(function* (
  renderer: CliRenderer,
  opened: OpenSession,
  options: ChatOptions,
  prompt: Option.Option<string>,
) {
  const { client, quitting } = yield* chatClient(opened, options);
  if (Option.isSome(prompt)) client.send(prompt.value);
  yield* Effect.promise(() => showChat(renderer, client));
  yield* quitting;
}, Effect.scoped);
