import { describe, expect, spyOn, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Deferred, Effect, Fiber } from "effect";
import { NotificationAudio, openAttention } from "../../src/tui/Notifications.ts";
import { turnAttention } from "../../src/tui/internal/turn-attention.ts";
import type { AgentEvent } from "../../src/core/Client.ts";

const start = { type: "run-started", prompt: "Hello" } as const;

const answered = { type: "run-ended", reason: "answered" } as const;

const testNotifications = (options: { enabled: boolean; sound: boolean }) =>
  Effect.gen(function* () {
    const terminal = yield* Effect.acquireRelease(
      Effect.promise(() => createTestRenderer({ width: 80, height: 24 })),
      (closing) => Effect.sync(() => closing.renderer.destroy()),
    );

    const banners = spyOn(terminal.renderer, "triggerNotification").mockReturnValue(true);

    const lifecycle: string[] = [];

    const audio = Effect.acquireRelease(
      Effect.sync(() => {
        lifecycle.push("open");

        return {
          play: Effect.sync(() => {
            lifecycle.push("play");
          }),
        };
      }),
      () =>
        Effect.sync(() => {
          lifecycle.push("close");
        }),
    );

    const attention = yield* openAttention(terminal.renderer, options).pipe(
      Effect.provideService(NotificationAudio, audio),
    );

    return {
      renderer: terminal.renderer,
      banners,
      lifecycle,
      attention,
      notify: turnAttention(attention),
    };
  });

describe("attention requests", () => {
  test("accepts direct requests without a running turn", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { renderer, banners, lifecycle, attention } = yield* testNotifications({
          enabled: true,
          sound: true,
        });

        renderer.emit("blur");
        yield* attention.request("Response ready");
        yield* attention.request("Run failed");

        expect(banners.mock.calls).toEqual([
          ["Response ready", "Tau"],
          ["Run failed", "Tau"],
        ]);

        expect(lifecycle).toEqual(["open", "play", "play"]);
      }).pipe(Effect.scoped),
    ));

  test("requests attention once while input requests overlap, and again after all are answered", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { renderer, banners, attention } = yield* testNotifications({
          enabled: true,
          sound: true,
        });

        renderer.emit("blur");
        const firstAnswer = yield* Deferred.make<string>();
        const secondAnswer = yield* Deferred.make<string>();
        const first = yield* Effect.forkChild(attention.waitForUser(Deferred.await(firstAnswer)));
        yield* Effect.yieldNow;
        const second = yield* Effect.forkChild(attention.waitForUser(Deferred.await(secondAnswer)));
        yield* Effect.yieldNow;
        expect(banners.mock.calls).toEqual([["Input needed", "Tau"]]);

        yield* Deferred.succeed(firstAnswer, "a");
        yield* Deferred.succeed(secondAnswer, "b");
        expect([yield* Fiber.join(first), yield* Fiber.join(second)]).toEqual(["a", "b"]);

        yield* attention.waitForUser(Effect.void);
        expect(banners.mock.calls).toHaveLength(2);
      }).pipe(Effect.scoped),
    ));

  test("an interrupted input request no longer counts as waiting", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { renderer, banners, attention } = yield* testNotifications({
          enabled: true,
          sound: true,
        });

        renderer.emit("blur");
        const waiting = yield* Effect.forkChild(attention.waitForUser(Effect.never));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiting);
        yield* attention.waitForUser(Effect.void);
        expect(banners.mock.calls).toHaveLength(2);
      }).pipe(Effect.scoped),
    ));

  test("turn tracking is separate for each session sharing attention", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const requests: string[] = [];

        const attention = {
          request: (message: string) =>
            Effect.sync(() => {
              requests.push(message);
            }),
        };

        const first = turnAttention(attention);
        const second = turnAttention(attention);
        yield* first(start);
        yield* second(answered);
        expect(requests).toEqual([]);
        yield* first(answered);
        yield* first(answered);
        yield* second(start);
        yield* second({ type: "run-ended", reason: "cancelled" });
        expect(requests).toEqual(["Response ready"]);
      }),
    ));

  test.each([
    { focus: "blur", calls: 1 },
    { focus: "focus", calls: 0 },
    { focus: "unknown", calls: 0 },
  ])("$focus focus controls banners while sound plays once", ({ focus, calls }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { renderer, banners, lifecycle, notify } = yield* testNotifications({
          enabled: true,
          sound: true,
        });

        if (focus !== "unknown") renderer.emit(focus);

        expect(lifecycle).toEqual([]);

        yield* notify(start);

        yield* notify(answered);

        yield* notify(answered);

        expect(banners).toHaveBeenCalledTimes(calls);

        if (calls) expect(banners).toHaveBeenCalledWith("Response ready", "Tau");

        expect(lifecycle).toEqual(["open", "play"]);
      }).pipe(Effect.scoped),
    ),
  );

  test.each([
    { enabled: false, sound: true, banners: 0 },
    { enabled: true, sound: false, banners: 1 },
  ])("enabled=$enabled sound=$sound never opens audio", (fixture) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { renderer, banners, lifecycle, attention } = yield* testNotifications(fixture);

        renderer.emit("blur");

        yield* attention.request("Response ready");

        expect(banners).toHaveBeenCalledTimes(fixture.banners);

        expect(lifecycle).toEqual([]);
      }).pipe(Effect.scoped),
    ),
  );

  test("ignores unstarted ends, intermediate events, and cancellation", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { renderer, banners, lifecycle, notify } = yield* testNotifications({
          enabled: true,
          sound: true,
        });

        renderer.emit("blur");

        const events: AgentEvent[] = [
          answered,
          start,
          { type: "text", delta: "Hi" },
          { type: "retrying", attempt: 1, seconds: 1, message: "Wait" },
          { type: "run-ended", reason: "cancelled" },
        ];

        yield* Effect.forEach(events, notify, { discard: true });

        expect(banners).not.toHaveBeenCalled();

        expect(lifecycle).toEqual([]);
      }).pipe(Effect.scoped),
    ));

  test("updates focus, alerts on failures, and reuses sound between turns", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { renderer, banners, lifecycle, notify } = yield* testNotifications({
          enabled: true,
          sound: true,
        });

        renderer.emit("blur");

        yield* notify(start);

        yield* notify({ type: "run-ended", reason: "failed", error: "Private details" });

        renderer.emit("focus");

        yield* notify(start);

        yield* notify(answered);

        expect(banners.mock.calls).toEqual([["Run failed", "Tau"]]);

        expect(lifecycle).toEqual(["open", "play", "play"]);
      }).pipe(Effect.scoped),
    ));

  test("closes audio and removes focus listeners with the terminal scope", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const terminal = yield* Effect.promise(() => createTestRenderer({ width: 80, height: 24 }));

        const renderer = terminal.renderer;

        const before = [renderer.listenerCount("focus"), renderer.listenerCount("blur")];

        const lifecycle: string[] = [];

        const audio = Effect.acquireRelease(Effect.succeed({ play: Effect.void }), () =>
          Effect.sync(() => {
            lifecycle.push("close");
          }),
        );

        yield* Effect.gen(function* () {
          const attention = yield* openAttention(renderer, {
            enabled: true,
            sound: true,
          }).pipe(Effect.provideService(NotificationAudio, audio));

          yield* attention.request("Response ready");
        }).pipe(Effect.scoped);

        expect(lifecycle).toEqual(["close"]);

        expect([renderer.listenerCount("focus"), renderer.listenerCount("blur")]).toEqual(before);

        renderer.destroy();
      }),
    ));

  test("a rejected banner does not prevent sound", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { renderer, banners, lifecycle, notify } = yield* testNotifications({
          enabled: true,
          sound: true,
        });

        banners.mockImplementation(() => {
          throw new Error("No banner");
        });

        renderer.emit("blur");

        yield* notify(start);

        yield* notify(answered);

        expect(lifecycle).toEqual(["open", "play"]);
      }).pipe(Effect.scoped),
    ));

  test("audio acquisition failure does not stop banners or later turns", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { renderer, banners } = yield* testNotifications({ enabled: true, sound: false });

        const attention = yield* openAttention(renderer, { enabled: true, sound: true }).pipe(
          Effect.provideService(
            NotificationAudio,
            Effect.try(() => {
              throw new Error("No audio device");
            }),
          ),
        );

        renderer.emit("blur");

        yield* attention.request("Response ready");

        yield* attention.request("Response ready");

        expect(banners).toHaveBeenCalledTimes(2);
      }).pipe(Effect.scoped),
    ));
});
