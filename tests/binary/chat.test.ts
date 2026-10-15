import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, FileSystem } from "effect";
import { compileTau } from "../support/compile-tau.ts";

// Builds the binary, so it takes seconds and runs before commit, not after each agent run.
const BUILD_AND_RUN_MILLIS = 60_000;

const CTRL_D = "\u0004";

/** The footer's last key hint, drawn once the chat is ready for keys. */
const CHAT_OPENED = "ctrl+d quit";

const ALTERNATE_SCREEN = { name: "alternate screen", on: "\u001B[?1049h", off: "\u001B[?1049l" };

/** Each terminal mode the chat turns on, and the sequence that turns it off again. */
const CHAT_MODES = [
  ALTERNATE_SCREEN,
  { name: "mouse tracking", on: "\u001B[?1003h", off: "\u001B[?1003l" },
  { name: "bracketed paste", on: "\u001B[?2004h", off: "\u001B[?2004l" },
  { name: "modified keys", on: "\u001B[>4;1m", off: "\u001B[>4;0m" },
];

/** The modes are on when the last sequence that changes each one turns it on. */
const modesLeftOn = (output: string) =>
  CHAT_MODES.filter((mode) => output.lastIndexOf(mode.on) > output.lastIndexOf(mode.off)).map(
    (mode) => mode.name,
  );

/** `stty -a` names a mode the terminal has turned off with a leading `-`. */
const isOn = (stty: string, mode: string) => new RegExp(`(^|\\s)${mode}(\\s|$)`).test(stty);

/**
 * Runs the compiled `tau` in a terminal from a shell, quits the chat once it opens, and then lets
 * the shell print Tau's exit code and the terminal's settings.
 */
const chatAndQuit = Effect.fn("chatAndQuit")(function* (binary: string) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped();
  const project = yield* fs.makeTempDirectoryScoped();
  const opened = yield* Deferred.make<void>();
  const decoder = new TextDecoder();
  let output = "";

  const terminal = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Bun.Terminal({
          cols: 80,
          rows: 24,
          data: (_terminal, bytes) => {
            output += decoder.decode(bytes, { stream: true });
            if (output.includes(CHAT_OPENED)) Deferred.doneUnsafe(opened, Effect.void);
          },
        }),
    ),
    (closing) => Effect.sync(() => closing.close()),
  );

  const script = `'${binary}'; echo "tau exited $?"; stty -a`;

  const shell = Bun.spawn(["/bin/sh", "-c", script], {
    cwd: project,
    env: { ...process.env, HOME: home },
    terminal,
  });

  yield* Deferred.await(opened);
  terminal.write(CTRL_D);
  yield* Effect.promise(() => shell.exited);
  return output;
});

describe("compiled tau", () => {
  test(
    "opens the chat, quits, and gives the terminal back",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const binary = yield* compileTau(yield* fs.makeTempDirectoryScoped());
        const output = yield* chatAndQuit(binary);
        const [chat = "", afterChat = ""] = output.split(ALTERNATE_SCREEN.off).slice(-2);

        expect(chat).toContain(CHAT_OPENED);
        expect(modesLeftOn(output)).toEqual([]);
        expect(afterChat).toMatch(/Session: [\w-]+/);
        expect(afterChat).toContain("tau exited 0");

        const stty = afterChat.slice(afterChat.indexOf("tau exited"));

        expect(["icanon", "echo", "isig"].filter((mode) => !isOn(stty, mode))).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise),
    BUILD_AND_RUN_MILLIS,
  );
});
