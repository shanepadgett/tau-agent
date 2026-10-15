import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Duration, Effect, Exit, FileSystem, Scope } from "effect";
import {
  makeProcessSessions,
  PROCESS_LIMITS,
  type ProcessLimits,
} from "../../src/proc/ProcessSessions.ts";

const withSessions = <A, E>(
  limits: ProcessLimits,
  body: (
    sessions: Effect.Success<ReturnType<typeof makeProcessSessions>>,
    directory: string,
  ) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
        const sessions = yield* makeProcessSessions(limits);

        return yield* body(sessions, directory);
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );

/** Starts with a short first wait, so a test spends its time on what it checks. */
const start = (command: string, directory: string, pty = false) => ({
  command,
  directory,
  pty,
  waitSeconds: 0.05,
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntilGone = (pid: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50 && alive(pid); attempt++)
      yield* Effect.sleep(Duration.millis(50));

    return alive(pid);
  });

const anyWait = { pattern: undefined, quietSeconds: 5, deadlineSeconds: 5 };

/** Starts a command that prints the pid of its background job, and gives that pid. */
const startWithJob = (
  sessions: Effect.Success<ReturnType<typeof makeProcessSessions>>,
  options: ReturnType<typeof start>,
) =>
  sessions
    .start({ ...options, waitSeconds: 0.25 })
    .pipe(Effect.map((started) => ({ ...started, pid: Number(started.waited.output.trim()) })));

describe("process sessions", () => {
  test("a short command returns its output and exit code at once", () =>
    withSessions(PROCESS_LIMITS, (sessions, directory) =>
      Effect.gen(function* () {
        const started = yield* sessions.start(start("echo hi", directory));

        expect(started.waited).toMatchObject({ reason: "exited", exitCode: 0, output: "hi\n" });
        expect(started.process.state).toEqual({ type: "exited", exitCode: 0 });
      }),
    ));

  test("a long command keeps running until killed, with its whole tree", () =>
    withSessions(PROCESS_LIMITS, (sessions, directory) =>
      Effect.gen(function* () {
        const started = yield* startWithJob(sessions, start("sleep 30 & echo $!; wait", directory));
        const { pid } = started;
        expect(started.process.state).toEqual({ type: "running" });
        expect(yield* sessions.list).toHaveLength(1);
        expect(alive(pid)).toBe(true);

        const killed = yield* sessions.kill(started.process.id);
        expect(killed.state).toEqual({ type: "killed" });
        expect(yield* waitUntilGone(pid)).toBe(false);
      }),
    ));

  test("a wait ends when the command exits", () =>
    withSessions(PROCESS_LIMITS, (sessions, directory) =>
      Effect.gen(function* () {
        const started = yield* sessions.start(start("sleep 0.2; echo done", directory));
        const exited = yield* sessions.wait(started.process.id, anyWait);

        expect(exited).toMatchObject({ reason: "exited", exitCode: 0, output: "done\n" });
      }),
    ));

  test("a wait ends on a matching line, then on quiet with the last lines", () =>
    withSessions(PROCESS_LIMITS, (sessions, directory) =>
      Effect.gen(function* () {
        const serving = yield* sessions.start(
          start("echo starting; sleep 0.2; echo ready; sleep 30", directory),
        );

        const matched = yield* sessions.wait(serving.process.id, { ...anyWait, pattern: /ready/ });
        expect(matched).toMatchObject({ reason: "matched" });

        const quiet = yield* sessions.wait(serving.process.id, { ...anyWait, quietSeconds: 0.2 });
        expect(quiet).toMatchObject({ reason: "quiet", output: "", tail: "starting\nready" });
      }),
    ));

  test("a wait ends at its deadline while output keeps coming", () =>
    withSessions(PROCESS_LIMITS, (sessions, directory) =>
      Effect.gen(function* () {
        const ticking = yield* sessions.start(
          start("while true; do echo tick; sleep 0.05; done", directory),
        );

        const late = yield* sessions.wait(ticking.process.id, { ...anyWait, deadlineSeconds: 0.3 });

        expect(late).toMatchObject({ reason: "deadline" });
        expect(late.reason === "deadline" ? late.output : "").toContain("tick");
      }),
    ));

  test(
    "a read gives only new output and readAll gives everything",
    () =>
      withSessions(PROCESS_LIMITS, (sessions, directory) =>
        Effect.gen(function* () {
          const { process: first } = yield* sessions.start(
            start("echo one; sleep 0.2; echo two; sleep 30", directory),
          );

          yield* sessions.wait(first.id, { ...anyWait, pattern: /two/ });

          expect((yield* sessions.read(first.id)).output).toBe("");
          expect(yield* sessions.readAll(first.id)).toBe("one\ntwo\n");
        }),
      ),
    10_000,
  );

  test("output over the buffer keeps its head and tail", () =>
    withSessions({ maxSessions: 4, bufferCharacters: 1000 }, (sessions, directory) =>
      Effect.gen(function* () {
        const started = yield* sessions.start({
          ...start("yes abcdefghi | head -c 2000000; echo END", directory),
          waitSeconds: 20,
        });

        expect(started.waited.reason).toBe("exited");
        const all = yield* sessions.readAll(started.process.id);
        expect(all.length).toBeLessThan(1200);
        expect(all).toContain("characters of output were dropped");
        expect(all.endsWith("END\n")).toBe(true);
      }),
    ));

  test("write reaches a pipe command", () =>
    withSessions(PROCESS_LIMITS, (sessions, directory) =>
      Effect.gen(function* () {
        const cat = yield* sessions.start(start("cat", directory));
        yield* sessions.write(cat.process.id, "hello\n");

        const echoed = yield* sessions.wait(cat.process.id, { ...anyWait, pattern: /hello/ });

        expect(echoed).toMatchObject({ reason: "matched" });
      }),
    ));

  test("a PTY command has a terminal and takes input", () =>
    withSessions(PROCESS_LIMITS, (sessions, directory) =>
      Effect.gen(function* () {
        const terminal = yield* sessions.start(
          start("test -t 0 && echo tty; cat", directory, true),
        );

        expect(terminal.waited).toMatchObject({ reason: "deadline", output: "tty\r\n" });

        yield* sessions.write(terminal.process.id, "typed\n");
        const echoed = yield* sessions.wait(terminal.process.id, { ...anyWait, pattern: /typed/ });

        expect(echoed).toMatchObject({ reason: "matched" });
        yield* sessions.kill(terminal.process.id);
      }),
    ));

  test("the limit counts running sessions", () =>
    withSessions({ maxSessions: 2, bufferCharacters: 1000 }, (sessions, directory) =>
      Effect.gen(function* () {
        yield* sessions.start(start("sleep 30", directory));
        yield* sessions.start(start("sleep 30", directory));
        const refused = yield* Effect.flip(sessions.start(start("sleep 30", directory)));
        expect(refused._tag).toBe("ProcessLimit");

        yield* sessions.kill("p1");
        yield* sessions.start(start("sleep 30", directory));
      }),
    ));

  test("closing the registry kills every command, including a background job", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
        const registry = yield* Scope.make();
        const sessions = yield* makeProcessSessions(PROCESS_LIMITS).pipe(Scope.provide(registry));

        const [piped, terminal] = yield* Effect.all(
          [
            startWithJob(sessions, start("sleep 30 & echo $!; wait", directory)),
            startWithJob(sessions, start("sleep 31 & echo $!; wait", directory, true)),
          ],
          { concurrency: "unbounded" },
        );

        const pids = [piped.pid, terminal.pid];
        expect(pids.every(alive)).toBe(true);

        yield* Scope.close(registry, Exit.void);

        for (const pid of pids) expect(yield* waitUntilGone(pid)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    ));

  test("a command that exits by itself is taken once", () =>
    withSessions(PROCESS_LIMITS, (sessions, directory) =>
      Effect.gen(function* () {
        const { process: detached } = yield* sessions.start(
          start("sleep 0.1; echo bye; exit 3", directory),
        );

        yield* Effect.sleep(Duration.millis(300));
        const [exit] = yield* sessions.takeExits;
        expect(exit?.process).toMatchObject({ id: detached.id, state: { exitCode: 3 } });
        expect(exit?.tail).toBe("bye");
        expect(yield* sessions.takeExits).toEqual([]);
      }),
    ));
});
