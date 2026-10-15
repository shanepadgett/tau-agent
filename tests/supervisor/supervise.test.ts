import { describe, expect, test } from "bun:test";
import { type Cause, Deferred, Effect, Fiber, type FileSystem, Layer, Queue, Stream } from "effect";
import { type Build, Builds } from "../../src/supervisor/Builds.ts";
import { Children } from "../../src/supervisor/Children.ts";
import type { ToChild, ToSupervisor } from "../../src/supervisor/Messages.ts";
import { superviseChat } from "../../src/supervisor/Supervisor.ts";

const FIRST: Build = { id: 1, command: ["tau-1"] };
const SECOND: Build = { id: 2, command: ["tau-2"] };

/** A chat child that the test drives: what it says, what it got, and when it exits. */
type FakeChat = {
  readonly build: Build;
  readonly args: readonly string[];
  readonly draft: string;
  readonly says: Queue.Queue<ToSupervisor, Cause.Done>;
  readonly got: Queue.Queue<ToChild>;
  readonly exit: Deferred.Deferred<number>;
};

/**
 * Builds and children that the test drives instead of real bundles and processes. A change in the
 * code runs `build`.
 */
const fakeServices = Effect.fn("fakeServices")(function* (build: Builds["Service"]["build"]) {
  const changes = yield* Queue.unbounded<FileSystem.WatchEvent>();
  const started = yield* Queue.unbounded<FakeChat>();

  const builds = Layer.succeed(Builds, {
    first: Effect.succeed(FIRST),
    changes: Stream.fromQueue(changes),
    build,
    prune: () => Effect.void,
  });

  const children = Layer.succeed(Children, {
    startChat: (build, args, draft) =>
      Effect.gen(function* () {
        const chat: FakeChat = {
          build,
          args,
          draft,
          says: yield* Queue.unbounded<ToSupervisor, Cause.Done>(),
          got: yield* Queue.unbounded<ToChild>(),
          exit: yield* Deferred.make<number>(),
        };

        yield* Queue.offer(started, chat);

        return {
          messages: Stream.fromQueue(chat.says),
          send: (message: ToChild) => Queue.offer(chat.got, message).pipe(Effect.asVoid),
          exited: Deferred.await(chat.exit),
        };
      }),
    check: () => Effect.void,
  });

  return { changes, started, layer: Layer.merge(builds, children) };
});

/** The first chat continues no session; later ones continue the one it opened. */
const argsFor = (session: string | undefined) =>
  session === undefined ? ["first prompt"] : ["--session", session];

const exitChat = (chat: FakeChat, code: number) =>
  Queue.end(chat.says).pipe(Effect.andThen(Deferred.succeed(chat.exit, code)));

/** Waits for a message of `type`, past the messages before it. */
const received = (chat: FakeChat, type: ToChild["type"]): Effect.Effect<ToChild> =>
  Queue.take(chat.got).pipe(
    Effect.flatMap((message) =>
      message.type === type ? Effect.succeed(message) : received(chat, type),
    ),
  );

describe("the supervisor", () => {
  test("restarts an idle chat into new code, with its session and unsent input", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fakes = yield* fakeServices(Effect.succeed(SECOND));
        const start = { argsFor, mode: "automatic" } as const;

        const supervising = yield* Effect.forkChild(
          superviseChat(start).pipe(Effect.provide(fakes.layer)),
        );

        const first = yield* Queue.take(fakes.started);

        yield* Queue.offerAll(first.says, [
          { type: "ready", session: "s1" },
          { type: "idle", idle: true },
        ]);

        yield* Queue.offer(fakes.changes, { _tag: "Update", path: "src/cli/main.ts" });
        yield* received(first, "exit-for-restart");
        yield* Queue.offer(first.says, { type: "handoff", session: "s1", draft: "unsent" });
        yield* exitChat(first, 0);

        const second = yield* Queue.take(fakes.started);
        yield* exitChat(second, 0);
        yield* Fiber.join(supervising);

        expect([first.build, first.args, first.draft]).toEqual([FIRST, ["first prompt"], ""]);

        expect([second.build, second.args, second.draft]).toEqual([
          SECOND,
          ["--session", "s1"],
          "unsent",
        ]);
      }),
    ));

  test("fails when the chat crashes twice soon after it starts and no older build is left", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fakes = yield* fakeServices(Effect.succeed(SECOND));
        const start = { argsFor, mode: "automatic" } as const;

        const supervising = yield* Effect.forkChild(
          superviseChat(start).pipe(Effect.provide(fakes.layer)),
        );

        const first = yield* Queue.take(fakes.started);
        yield* Queue.offer(first.says, { type: "ready", session: "s1" });
        yield* exitChat(first, 1);
        const second = yield* Queue.take(fakes.started);
        yield* exitChat(second, 1);
        const error = yield* Effect.flip(Fiber.join(supervising));

        expect(second.args).toEqual(["--session", "s1"]);
        expect(error).toMatchObject({ _tag: "TauCrashed", session: "s1" });
      }),
    ));

  test("tells the chat why new code does not build, and keeps the chat", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const released = yield* Builds.pipe(Effect.provide(Builds.binary));
        const fakes = yield* fakeServices(released.build);
        const start = { argsFor, mode: "automatic" } as const;

        const supervising = yield* Effect.forkChild(
          superviseChat(start).pipe(Effect.provide(fakes.layer)),
        );

        const first = yield* Queue.take(fakes.started);
        yield* Queue.offer(first.says, { type: "ready", session: "s1" });
        yield* Queue.offer(fakes.changes, { _tag: "Update", path: "src/cli/main.ts" });
        const message = yield* received(first, "conditions");
        yield* exitChat(first, 0);
        yield* Fiber.join(supervising);

        expect(message).toMatchObject({
          conditions: [
            {
              key: "reload.code",
              severity: "warning",
              text: "The new code does not build: A released Tau does not rebuild itself.",
            },
          ],
        });
      }),
    ));
});
