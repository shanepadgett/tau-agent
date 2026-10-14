/**
 * The chat in the terminal, which `tau` opens when `-p` is not given. Import it lazily: it loads
 * OpenTUI's native renderer, which print mode does not need.
 */

import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { Effect } from "effect";
import type { OpenSession } from "../core/Agent.ts";
import { showChat } from "./internal/App.tsx";
import { type ChatEnd, type ChatSetup, chatClient } from "./internal/chat-client.ts";

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

export type { ChatOptions, ChatSetup, RestartLink } from "./internal/chat-client.ts";

/** Shows the chat of `opened` in the terminal until the user quits or Tau restarts. */
export const chatInTerminal = Effect.fn("chatInTerminal")(function* (
  opened: OpenSession,
  setup: ChatSetup,
) {
  const renderer = yield* openTerminal;
  return yield* runTui(renderer, opened, setup);
}, Effect.scoped);

/** Shows the chat of `opened` on `renderer` until the user quits or Tau restarts. */
export const runTui = Effect.fn("runTui")(function* (
  renderer: CliRenderer,
  opened: OpenSession,
  setup: ChatSetup,
) {
  const { client, ended } = yield* chatClient(opened, setup);
  if (setup.prompt !== undefined) client.send(setup.prompt);
  yield* Effect.promise(() => showChat(renderer, client));
  const end: ChatEnd = yield* ended;
  return end;
}, Effect.scoped);
