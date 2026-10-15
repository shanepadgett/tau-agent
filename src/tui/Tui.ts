/**
 * The chat in the terminal, which `tau` opens when `-p` is not given. Import it lazily: it loads
 * OpenTUI's native renderer, which print mode does not need.
 */

import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { Effect } from "effect";
import { type Attention, openAttention } from "./Notifications.ts";
import { createSignal } from "solid-js";
import type { OpenSession } from "../core/Agent.ts";
import { showChat } from "./internal/App.tsx";
import {
  type ChatClient,
  type ChatEnd,
  type ChatSetup,
  chatClient,
} from "./internal/chat-client.ts";

/**
 * Takes over the terminal for the chat. Closing the scope gives the terminal back as it was. The
 * kitty keyboard protocol lets Tau tell Shift-Enter and Ctrl-Enter from Enter.
 *
 * `destroy` restores the terminal later, so the release waits for `closed`. Otherwise text printed
 * after the chat goes to the chat's alternate screen and disappears with it. `closed` fails only
 * when the terminal's output broke, and then nothing more can reach it.
 */
const openTerminal = Effect.acquireRelease(
  Effect.promise(() => createCliRenderer({ exitOnCtrlC: false, useKittyKeyboard: {} })),
  (renderer) =>
    Effect.tryPromise(() => {
      renderer.destroy();
      return renderer.closed;
    }).pipe(Effect.ignore),
);

export type { ChatAgent, ChatOptions, ChatSetup, RestartLink } from "./internal/chat-client.ts";

/**
 * Why the chat ended, and the session it showed last. A restart keeps the unsent input for the next
 * chat.
 */
type TuiEnd = Exclude<ChatEnd, { reason: "open" }> & {
  readonly session: OpenSession["session"]["id"];
};

/** Shows the chat of `opened` in the terminal until the user quits or Tau restarts. */
export const chatInTerminal = Effect.fn("chatInTerminal")(function* (
  opened: OpenSession,
  setup: ChatSetup,
) {
  const renderer = yield* openTerminal;
  return yield* runTui(renderer, opened, setup);
}, Effect.scoped);

/**
 * Shows the chat of `opened` on `renderer` until the user quits or Tau restarts. When the user
 * picks another session, or a new one, the chat shows it on the same screen.
 */
export const runTui = Effect.fn("runTui")(function* (
  renderer: CliRenderer,
  opened: OpenSession,
  setup: ChatSetup,
) {
  const attention = yield* openAttention(renderer, setup.notifications);
  const [client, setClient] = createSignal<ChatClient>();
  let isShown = false;

  const show = (next: ChatClient) =>
    Effect.suspend(() => {
      setClient(() => next);
      if (isShown) return Effect.void;
      isShown = true;
      return Effect.promise(() => showChat(renderer, client));
    });

  let end = yield* chatSession(opened, setup, show, attention);

  // A later session starts with an empty input and no first prompt.
  const later: ChatSetup = {
    ...setup,
    prompt: undefined,
    link: { ...setup.link, draft: "", attention: undefined },
  };

  while (end.reason === "open") {
    const session = end.session;

    end = yield* setup.agent.open(session).pipe(
      Effect.flatMap((next) => chatSession(next, later, show, attention)),
      Effect.scoped,
    );
  }

  return end;
});

/** Shows one session until the chat ends. The session's client stops with it. */
const chatSession = Effect.fn("chatSession")(function* (
  opened: OpenSession,
  setup: ChatSetup,
  show: (client: ChatClient) => Effect.Effect<void>,
  attention: Attention,
) {
  const { client, ended } = yield* chatClient(opened, setup, attention);
  if (setup.prompt !== undefined) client.send(setup.prompt);
  yield* show(client);
  const end: ChatEnd = yield* ended;
  if (end.reason === "open") return end;
  const finished: TuiEnd = { ...end, session: opened.session.id };
  return finished;
}, Effect.scoped);
