import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, FileSystem } from "effect";
import { TauHome } from "../../src/database/TauHome.ts";
import { Sessions } from "../../src/session/Sessions.ts";
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

/** A file in the project, which `@` must list: FFF's native library has to load from the binary. */
const PROJECT_FILE = "findme.txt";

/**
 * Runs the compiled `tau` in a terminal from a shell, types `@` and part of a file's name once the
 * chat opens, quits once the list shows the file, and then lets the shell print Tau's exit code and
 * the terminal's settings.
 */
const chatAndQuit = Effect.fn("chatAndQuit")(function* (binary: string, kind: "draft" | "saved") {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped();
  const project = yield* fs.makeTempDirectoryScoped();
  yield* fs.writeFileString(`${project}/${PROJECT_FILE}`, "");
  const session = kind === "saved" ? yield* seedSession(home, project) : undefined;
  const opened = yield* Deferred.make<void>();
  const found = yield* Deferred.make<void>();
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
            if (output.includes(PROJECT_FILE)) Deferred.doneUnsafe(found, Effect.void);
          },
        }),
    ),
    (closing) => Effect.sync(() => closing.close()),
  );

  const args = session === undefined ? "" : ` --session '${session}'`;
  const script = `'${binary}'${args}; echo "tau exited $?"; stty -a`;

  const shell = Bun.spawn(["/bin/sh", "-c", script], {
    cwd: project,
    env: { ...process.env, HOME: home },
    terminal,
  });

  yield* Deferred.await(opened);
  terminal.write("@findm");
  yield* Deferred.await(found);
  terminal.write(CTRL_D);
  yield* Effect.promise(() => shell.exited);

  const saved = yield* Sessions.use((sessions) => sessions.list(project)).pipe(
    Effect.provide(Sessions.layer),
    Effect.provideService(TauHome, { directory: `${home}/.tau` }),
  );

  return { output, session, saved: saved.map(({ id }) => id) };
});

describe("compiled tau", () => {
  test.each(["draft", "saved"] as const)(
    "opens a %s chat, lists a file after @, quits, and gives the terminal back",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const binary = yield* compileTau(yield* fs.makeTempDirectoryScoped());
        const { output, session, saved } = yield* chatAndQuit(binary, kind);
        const [chat = "", afterChat = ""] = output.split(ALTERNATE_SCREEN.off).slice(-2);

        expect(saved).toEqual(session === undefined ? [] : [session]);
        expect(chat).toContain(CHAT_OPENED);
        expect(modesLeftOn(output)).toEqual([]);

        if (session === undefined) {
          expect(output).not.toContain("Session:");
        } else {
          // A whole line with no color around it.
          expect(afterChat).toContain(`\nSession: ${session}\r\n`);
        }

        expect(afterChat).toContain("tau exited 0");

        const stty = afterChat.slice(afterChat.indexOf("tau exited"));

        expect(["icanon", "echo", "isig"].filter((mode) => !isOn(stty, mode))).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise),
    BUILD_AND_RUN_MILLIS,
  );
});

const seedSession = Effect.fn("seedSession")(function* (home: string, project: string) {
  return yield* Sessions.use((sessions) =>
    Effect.gen(function* () {
      const session = yield* sessions.allocate(project);
      yield* sessions.start(session, [{ type: "user", text: "Saved prompt." }]);
      return session.id;
    }),
  ).pipe(
    Effect.provide(Sessions.layer),
    Effect.provideService(TauHome, { directory: `${home}/.tau` }),
  );
});
