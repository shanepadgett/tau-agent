import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { ContextMethod } from "../../src/core/ContextMethod.ts";
import { SessionId } from "../../src/session/Entry.ts";
import { prompt, textReply, withHarness } from "../support/agent-harness.ts";

describe("session persistence", () => {
  test("background work starts once after the first save and immediately when resuming", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        let started = 0;

        const method = Layer.effect(
          ContextMethod,
          Effect.gen(function* () {
            const whole = yield* ContextMethod;

            return {
              ...whole,
              background: () =>
                Effect.sync(() => {
                  started += 1;
                }),
            };
          }),
        ).pipe(Layer.provide(ContextMethod.wholeHistory));

        const agent = yield* harness.startAgentUsing(
          [textReply("One."), textReply("Two.")],
          method,
        );

        const id = yield* Effect.scoped(
          Effect.gen(function* () {
            const opened = yield* agent.open(Option.none(), harness.directory);
            expect(started).toBe(0);
            yield* opened.references.set(["example"]);
            expect(started).toBe(0);
            yield* prompt(opened, "First.");
            yield* prompt(opened, "Second.");
            expect(started).toBe(1);
            return opened.session.id;
          }),
        );

        yield* agent.open(Option.some(id), harness.directory);
        expect(started).toBe(2);
      }),
    ));

  test("a cancelled first run keeps its saved prompt resumable", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([Stream.never]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const running = yield* Effect.forkScoped(prompt(opened, "Cancel this."));
        yield* opened.snapshot.pipe(Effect.repeat({ until: (state) => state.kind === "saved" }));
        yield* opened.send({ type: "cancel" });
        const events = yield* Fiber.join(running);
        expect(events).toContainEqual({ type: "run-ended", reason: "cancelled" });
        expect((yield* agent.sessions(harness.directory))[0]?.firstPrompt).toBe("Cancel this.");
      }),
    ));

  test("opening and discarding chats and choosing references never saves a session", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([]);

        for (let index = 0; index < 3; index += 1) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const opened = yield* agent.open(Option.none(), harness.directory);
              yield* opened.references.set(["example"]);
              expect((yield* opened.snapshot).kind).toBe("draft");
              expect(yield* harness.sessions.entries(opened.session.id, 0)).toEqual([]);
              expect(yield* agent.sessions(harness.directory)).toEqual([]);
            }),
          );
        }

        expect(yield* agent.sessions(harness.directory)).toEqual([]);
      }),
    ));

  test("the first prompt saves once, keeps reference choices, and later prompts append", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([textReply("One."), textReply("Two.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* opened.references.set(["first"]);
        yield* opened.references.set(["second"]);
        yield* prompt(opened, "Hello.");
        expect((yield* opened.snapshot).kind).toBe("saved");
        const same = yield* agent.open(Option.some(opened.session.id), harness.directory);
        expect(same).toBe(opened);
        yield* prompt(same, "Again.");
        const entries = yield* harness.sessions.entries(opened.session.id, 0);

        expect(entries.filter(({ body }) => body.type === "user").map(({ body }) => body)).toEqual([
          { type: "user", text: "Hello." },
          { type: "user", text: "Again." },
        ]);

        expect(
          entries.filter(({ body }) => body.type === "references").map(({ body }) => body),
        ).toEqual([{ type: "references", names: ["second"] }]);

        expect(yield* agent.sessions(harness.directory)).toHaveLength(1);
      }),
    ));

  test("restart restores a draft identity and reference choices without saving it", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const first = yield* harness.startAgent([]);

        const draft = yield* Effect.scoped(
          Effect.gen(function* () {
            const opened = yield* first.open(Option.none(), harness.directory);
            yield* opened.references.set(["example"]);
            return yield* opened.snapshot;
          }),
        );

        if (draft.kind !== "draft") throw new Error("Expected an unsaved draft.");
        const next = yield* harness.startAgent([textReply("Restored.")]);
        const restored = yield* next.open(Option.some(draft), harness.directory);
        expect(yield* restored.snapshot).toEqual(draft);

        expect(yield* restored.history).toEqual([
          { type: "references-changed", names: ["example"] },
        ]);

        expect(yield* next.sessions(harness.directory)).toEqual([]);
        yield* prompt(restored, "Save now.");
        expect((yield* harness.sessions.get(draft.session.id)).id).toBe(draft.session.id);
      }),
    ));

  test("a stale draft handoff resumes the committed session after a crash", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const first = yield* harness.startAgent([textReply("Saved.")]);

        const draft = yield* Effect.scoped(
          Effect.gen(function* () {
            const opened = yield* first.open(Option.none(), harness.directory);
            const beforeSave = yield* opened.snapshot;
            yield* prompt(opened, "Committed.");
            return beforeSave;
          }),
        );

        if (draft.kind !== "draft") throw new Error("Expected the pre-save handoff.");
        const next = yield* harness.startAgent([]);
        const restored = yield* next.open(Option.some(draft), harness.directory);
        expect((yield* restored.snapshot).kind).toBe("saved");

        expect(yield* restored.history).toContainEqual({
          type: "run-started",
          prompt: "Committed.",
        });

        expect(yield* next.sessions(harness.directory)).toHaveLength(1);
      }),
    ));

  test("an unknown saved ID fails instead of opening a draft", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([]);

        const error = yield* Effect.flip(
          agent.open(Option.some(SessionId.make("missing")), harness.directory),
        );

        expect(error._tag).toBe("SessionNotFound");
        expect(yield* agent.sessions(harness.directory)).toEqual([]);
      }),
    ));
});
