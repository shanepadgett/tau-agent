import { describe, expect, test } from "bun:test";
import { BunCrypto, BunFileSystem } from "@effect/platform-bun";
import { Context, type Crypto, Effect, FileSystem, Layer, type Scope } from "effect";
import type { Prompt } from "effect/ai";
import { TestClock } from "effect/testing";
import { RouteId } from "../src/ai/routes.ts";
import { contextView } from "../src/session/context-view.ts";
import { type EntryBody, SessionId } from "../src/session/entry.ts";
import { Sessions, sessionsLayer } from "../src/session/sessions.ts";

const project = "/work/project";
const model = { route: RouteId.make("anthropic"), model: "claude-sonnet-5-5" };
const thinking = { anthropic: { info: { type: "thinking", signature: "signature-1" } } } as const;

const user = (text: string): EntryBody => ({ type: "user", text });

const answer = (text: string): EntryBody => ({
  type: "assistant",
  model,
  parts: [{ type: "text", text, providerData: {} }],
});

const toolResult = (callId: string): EntryBody => ({
  type: "tool-result",
  callId,
  name: "run",
  result: { exitCode: 0 },
  isFailure: false,
});

const openSessions = (tauDirectory: string) =>
  Layer.build(sessionsLayer(tauDirectory)).pipe(
    Effect.map((context) => Context.get(context, Sessions)),
  );

type SessionServices = Scope.Scope | FileSystem.FileSystem | Crypto.Crypto;

const runInTempHome = <A, E>(
  program: (tauDirectory: string) => Effect.Effect<A, E, SessionServices>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      return yield* program(`${home}/.tau`);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunCrypto.layer, TestClock.layer())),
    ),
  );

const numbers = (sessions: Sessions["Service"], session: SessionId) =>
  sessions.entries(session, 0).pipe(Effect.map((entries) => entries.map((entry) => entry.number)));

describe("sessions", () => {
  test("a saved session gives the model the same messages and provider data", () =>
    runInTempHome((tauDirectory) =>
      Effect.gen(function* () {
        const writer = yield* openSessions(tauDirectory);
        const session = yield* writer.create(project);

        yield* writer.append(session.id, [
          user("Rename update to refresh."),
          {
            type: "assistant",
            model,
            parts: [
              { type: "reasoning", text: "Find the callers.", providerData: thinking },
              {
                type: "tool-call",
                id: "call-1",
                name: "run",
                params: { code: "1" },
                providerData: {},
              },
              {
                type: "tool-call",
                id: "call-2",
                name: "run",
                params: { code: "2" },
                providerData: {},
              },
            ],
          },
          toolResult("call-1"),
          toolResult("call-2"),
          answer("Done."),
        ]);

        const reader = yield* openSessions(tauDirectory);
        const prompt = contextView(yield* reader.entries(session.id, 0));

        expect(prompt.content.map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "tool",
          "assistant",
        ]);

        const parts = prompt.content.flatMap((message): readonly Prompt.Part[] =>
          message.role === "system" ? [] : message.content,
        );

        const reasoning = parts.find((part) => part.type === "reasoning");
        expect(reasoning?.options).toEqual(thinking);

        // Both results sit in the one tool message, so their parts are next to each other.
        const resultIds = parts.flatMap((part) => (part.type === "tool-result" ? [part.id] : []));

        expect(resultIds).toEqual(["call-1", "call-2"]);
      }),
    ));

  test("a fork copies the parent's entries up to the chosen one, and both then grow apart", () =>
    runInTempHome((tauDirectory) =>
      Effect.gen(function* () {
        const sessions = yield* openSessions(tauDirectory);
        const parent = yield* sessions.create(project);

        yield* sessions.append(parent.id, [
          user("one"),
          answer("two"),
          user("three"),
          answer("four"),
        ]);

        const branch = yield* sessions.fork(parent.id, 2);
        yield* sessions.append(branch.id, [user("other three")]);
        yield* sessions.append(parent.id, [user("five")]);

        const branchEntries = yield* sessions.entries(branch.id, 0);
        expect(branch.origin).toEqual({ kind: "fork", from: parent.id, through: 2 });

        expect(branchEntries.map((entry) => entry.body)).toEqual([
          user("one"),
          answer("two"),
          user("other three"),
        ]);

        expect(yield* numbers(sessions, parent.id)).toEqual([1, 2, 3, 4, 5]);

        const pastTheEnd = yield* Effect.flip(sessions.fork(parent.id, 9));
        expect(pastTheEnd._tag).toBe("EntryNotFound");
      }),
    ));

  test("two processes that share sessions.db number one session's entries in order", () =>
    runInTempHome((tauDirectory) =>
      Effect.gen(function* () {
        const first = yield* openSessions(tauDirectory);
        const second = yield* openSessions(tauDirectory);
        const session = yield* first.create(project);

        yield* first.append(session.id, [user("from the first")]);
        yield* second.append(session.id, [user("from the second")]);

        expect(yield* numbers(first, session.id)).toEqual([1, 2]);
      }),
    ));

  test("a reader resumes after the last entry it saw", () =>
    runInTempHome((tauDirectory) =>
      Effect.gen(function* () {
        const sessions = yield* openSessions(tauDirectory);
        const session = yield* sessions.create(project);
        yield* sessions.append(session.id, [user("one"), answer("two"), user("three")]);

        const unseen = yield* sessions.entries(session.id, 2);
        expect(unseen.map((entry) => entry.body)).toEqual([user("three")]);

        const unknown = yield* Effect.flip(sessions.append(SessionId.make("missing"), []));

        expect(unknown._tag).toBe("SessionNotFound");
      }),
    ));

  test("each directory lists its own sessions, most recently changed first", () =>
    runInTempHome((tauDirectory) =>
      Effect.gen(function* () {
        const sessions = yield* openSessions(tauDirectory);
        const older = yield* sessions.create(project);
        yield* TestClock.adjust("1 second");
        const newer = yield* sessions.create(project);
        const elsewhere = yield* sessions.create("/work/other");

        const ids = sessions
          .list(project)
          .pipe(Effect.map((list) => list.map((session) => session.id)));

        expect(yield* ids).toEqual([newer.id, older.id]);

        yield* TestClock.adjust("1 second");
        yield* sessions.append(older.id, [user("again")]);
        expect(yield* ids).toEqual([older.id, newer.id]);

        const other = yield* sessions.list("/work/other");
        expect(other.map((session) => session.id)).toEqual([elsewhere.id]);
      }),
    ));
});
