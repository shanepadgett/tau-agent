import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Context, Deferred, Effect, Layer, Option } from "effect";
import { AiError, type Response } from "effect/ai";
import { TauHome } from "../../src/database/TauHome.ts";
import type { Entry, SessionId } from "../../src/session/Entry.ts";
import { Notes } from "../../src/session/Notes.ts";
import { Sessions } from "../../src/session/Sessions.ts";
import {
  options,
  prompt,
  runEnd,
  textReply,
  userTexts,
  withHarness,
} from "../support/agent-harness.ts";
import {
  assistant,
  checkpointReply,
  contextLayer,
  promptText,
  waitForMemories,
  waitForNotes,
} from "../support/compaction.ts";

type Stores = {
  readonly sessions: Sessions["Service"];
  readonly notes: Notes["Service"];
  readonly directory: string;
};

const modelReply = (text: string) =>
  Effect.succeed<Response.PartEncoded[]>([{ type: "text", text }]);

/** Notes never start in these tests, so the only model calls are the dreams under test. */
const quietNotes = contextLayer({ notesStartTokens: 1_000_000 });

/** Sixteen notes of about 2000 tokens each, over entries 1–32: past the 30k trigger. */
const seedLongSession = Effect.fn("seedLongSession")(function* (stores: Stores) {
  const session = yield* stores.sessions.create(stores.directory);

  yield* stores.sessions.append(
    session.id,
    Array.from({ length: 16 }, (_, index) => [
      { type: "user" as const, text: `Request ${index + 1}` },
      assistant(`Answer ${index + 1}`),
    ]).flat(),
  );

  for (let number = 1; number <= 16; number += 1) {
    yield* stores.notes.append(session.id, {
      from: number * 2 - 1,
      through: number * 2,
      text: `[note ${number}] ${"x".repeat(8000)}`,
      model: options.model,
    });
  }

  return session;
});

const checkpointDetails = (entries: readonly Entry[]) => {
  const found = entries.find(
    ({ body }) => body.type === "tool-result" && body.details?.tool === "checkpoint",
  );

  if (found?.body.type !== "tool-result" || found.body.details?.tool !== "checkpoint")
    throw new Error("The checkpoint result is saved.");

  return found.body.details;
};

describe("dreaming", () => {
  test("past 30k uncovered note tokens a dream folds the oldest notes and keeps about 8k as notes", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* seedLongSession(harness);

        const agent = yield* harness.startAgentUsing([], quietNotes, [
          modelReply("Folded memory."),
        ]);

        yield* agent.open(Option.some(session.id), harness.directory);
        const [memory] = yield* waitForMemories(harness.notes, session.id, 1);

        expect(memory).toMatchObject({ number: 1, throughNote: 12, throughEntry: 24 });
        expect(memory?.text).toBe("Folded memory.");
        expect(harness.notePrompts).toHaveLength(1);
        expect(promptText(harness.notePrompts[0])).toContain("No memory yet.");
        expect(promptText(harness.notePrompts[0])).toContain("[note 1]");
        expect(promptText(harness.notePrompts[0])).toContain("[note 12]");
        expect(promptText(harness.notePrompts[0])).not.toContain("[note 13]");
        expect(yield* harness.notes.list(session.id)).toHaveLength(16);
      }),
    ));

  test("a saved memory changes no model call until the next checkpoint pins it", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* seedLongSession(harness);

        const agent = yield* harness.startAgentUsing(
          [checkpointReply("cp"), textReply("Done.")],
          quietNotes,
          [modelReply("Folded memory.")],
        );

        const opened = yield* agent.open(Option.some(session.id), harness.directory);
        yield* waitForMemories(harness.notes, session.id, 1);
        expect(runEnd(yield* prompt(opened, "Continue."))?.reason).toBe("answered");

        expect(promptText(harness.prompts[0])).not.toContain("Folded memory.");
        expect(promptText(harness.prompts[0])).toContain("Request 1");

        const texts = userTexts(harness.prompts[1]);
        expect(texts[0]).toBe("Session memory of entries 1–24:\nFolded memory.");

        expect(texts.slice(1, 5).map((text) => text.slice(0, 45))).toEqual([
          "Notes on entries 25–26:\n[note 13] xxxxxxxxxxx",
          "Notes on entries 27–28:\n[note 14] xxxxxxxxxxx",
          "Notes on entries 29–30:\n[note 15] xxxxxxxxxxx",
          "Notes on entries 31–32:\n[note 16] xxxxxxxxxxx",
        ]);

        expect(texts.indexOf("Continue.")).toBe(5);
        expect(texts.at(-1)).toStartWith("Your handoff at the checkpoint");
        expect(promptText(harness.prompts[1])).not.toContain("[note 12]");
        expect(promptText(harness.prompts[1])).not.toContain("Request 1");

        const details = checkpointDetails(yield* harness.sessions.entries(session.id, 0));
        expect(details).toMatchObject({ memory: 1, notes: [13, 14, 15, 16], tailFrom: 33 });
      }),
    ));

  test("a second dream reads the first memory and only newer notes", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* seedLongSession(harness);

        const agent = yield* harness.startAgentUsing([textReply("Ok.")], quietNotes, [
          modelReply("First memory."),
          modelReply("Second memory."),
        ]);

        const opened = yield* agent.open(Option.some(session.id), harness.directory);
        yield* waitForMemories(harness.notes, session.id, 1);

        for (let number = 17; number <= 28; number += 1) {
          yield* harness.notes.append(session.id, {
            from: number + 16,
            through: number + 16,
            text: `[note ${number}] ${"x".repeat(8000)}`,
            model: options.model,
          });
        }

        yield* prompt(opened, "Wake up.");
        const memories = yield* waitForMemories(harness.notes, session.id, 2);

        expect(memories.map(({ number, throughNote }) => [number, throughNote])).toEqual([
          [1, 12],
          [2, 24],
        ]);

        expect(memories[1]?.text).toBe("Second memory.");
        expect(promptText(harness.notePrompts[1])).toContain("First memory.");
        expect(promptText(harness.notePrompts[1])).toContain("[note 13]");
        expect(promptText(harness.notePrompts[1])).toContain("[note 24]");
        expect(promptText(harness.notePrompts[1])).not.toContain("[note 12]");
        expect(promptText(harness.notePrompts[1])).not.toContain("[note 25]");
      }),
    ));

  test("the note writer reads the latest memory and the notes after it, never the folded notes", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* seedLongSession(harness);

        yield* harness.notes.appendMemory(session.id, {
          parent: undefined,
          throughNote: 12,
          text: "Seeded memory.",
          model: options.model,
        });

        yield* harness.sessions.append(session.id, [
          { type: "user", text: "y".repeat(70000) },
          assistant("Recent reply."),
        ]);

        const agent = yield* harness.startAgentUsing([], contextLayer({ notesStartTokens: 1 }));
        yield* agent.open(Option.some(session.id), harness.directory);
        const saved = yield* waitForNotes(harness.notes, session.id, 17);

        expect(saved[16]).toMatchObject({ from: 33, through: 33 });
        expect(promptText(harness.notePrompts[0])).toContain("Seeded memory.");
        expect(promptText(harness.notePrompts[0])).toContain("[note 13]");
        expect(promptText(harness.notePrompts[0])).toContain("[note 16]");
        expect(promptText(harness.notePrompts[0])).not.toContain("[note 12]");
      }),
    ));

  test("an empty dream saves nothing and the next run's wake writes the memory", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* seedLongSession(harness);
        const finished = yield* Deferred.make<void>();

        const empty = Effect.succeed<Response.PartEncoded[]>([]).pipe(
          Effect.ensuring(Deferred.succeed(finished, undefined)),
        );

        const agent = yield* harness.startAgentUsing([textReply("Ok.")], quietNotes, [empty]);
        const opened = yield* agent.open(Option.some(session.id), harness.directory);
        yield* Deferred.await(finished);
        expect(yield* harness.notes.memories(session.id)).toHaveLength(0);

        expect(runEnd(yield* prompt(opened, "Continue."))?.reason).toBe("answered");
        const [memory] = yield* waitForMemories(harness.notes, session.id, 1);
        expect(memory).toMatchObject({ throughNote: 12, text: "Saved background note." });
        expect(harness.notePrompts).toHaveLength(2);
      }),
    ));

  test("a failed dream saves nothing and the next run's wake retries", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* seedLongSession(harness);
        const finished = yield* Deferred.make<void>();

        const failed = Effect.fail(
          AiError.make({
            module: "test",
            method: "dream",
            reason: new AiError.InvalidOutputError({ description: "Scripted dream failure." }),
          }),
        ).pipe(Effect.ensuring(Deferred.succeed(finished, undefined)));

        const agent = yield* harness.startAgentUsing([textReply("Ok.")], quietNotes, [failed]);
        const opened = yield* agent.open(Option.some(session.id), harness.directory);
        yield* Deferred.await(finished);
        expect(yield* harness.notes.memories(session.id)).toHaveLength(0);

        yield* prompt(opened, "Continue.");
        expect(yield* waitForMemories(harness.notes, session.id, 1)).toHaveLength(1);
        expect(harness.notePrompts).toHaveLength(2);
      }),
    ));

  test("appendMemory refuses a stale parent, a missing note and a memory with no new notes", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* harness.sessions.create(harness.directory);

        for (const number of [1, 2, 3]) {
          yield* harness.notes.append(session.id, {
            from: number,
            through: number,
            text: `Note ${number}.`,
            model: options.model,
          });
        }

        const memory = (parent: number | undefined, throughNote: number) => ({
          parent,
          throughNote,
          text: "Memory.",
          model: options.model,
        });

        const first = yield* harness.notes.appendMemory(session.id, memory(undefined, 2));
        expect(first).toMatchObject({ number: 1, throughNote: 2, throughEntry: 2 });

        const reasons = yield* Effect.forEach(
          [memory(undefined, 3), memory(1, 9), memory(1, 2)],
          (attempt) =>
            harness.notes.appendMemory(session.id, attempt).pipe(
              Effect.flip,
              Effect.map((error) => (error._tag === "MemoryConflict" ? error.reason : error._tag)),
            ),
        );

        expect(reasons).toEqual(["newer memory exists", "note missing", "no new notes"]);
        expect(yield* harness.notes.memories(session.id)).toHaveLength(1);
      }),
    ));

  test("a fork keeps only the memories within its range and memories survive reopening the database", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* harness.sessions.create(harness.directory);

        yield* harness.sessions.append(session.id, [
          { type: "user", text: "One." },
          assistant("Two."),
          { type: "user", text: "Three." },
          assistant("Four."),
        ]);

        for (const [from, through] of [
          [1, 2],
          [3, 4],
        ] as const) {
          yield* harness.notes.append(session.id, {
            from,
            through,
            text: `Note ${from}–${through}.`,
            model: options.model,
          });
        }

        yield* harness.notes.appendMemory(session.id, {
          parent: undefined,
          throughNote: 1,
          text: "First memory.",
          model: options.model,
        });

        yield* harness.notes.appendMemory(session.id, {
          parent: 1,
          throughNote: 2,
          text: "Second memory.",
          model: options.model,
        });

        const branch = yield* harness.sessions.fork(session.id, 3);

        const store = yield* Layer.build(
          Sessions.layer.pipe(
            Layer.provide(TauHome.at(`${harness.home}/.tau`)),
            Layer.provide(BunServices.layer),
          ),
        );

        const reopened = Context.get(store, Notes);

        const texts = (id: SessionId) =>
          reopened.memories(id).pipe(Effect.map((memories) => memories.map(({ text }) => text)));

        expect(yield* texts(branch.id)).toEqual(["First memory."]);
        expect(yield* texts(session.id)).toEqual(["First memory.", "Second memory."]);
      }),
    ));

  test("a checkpoint whose memory covers every note starts the raw tail after the memory's last entry", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* harness.sessions.create(harness.directory);

        yield* harness.sessions.append(session.id, [
          { type: "user", text: "Request 1" },
          assistant("Answer 1"),
          { type: "user", text: "Request 2" },
          assistant("Answer 2"),
        ]);

        for (const [from, through] of [
          [1, 2],
          [3, 4],
        ] as const) {
          yield* harness.notes.append(session.id, {
            from,
            through,
            text: `Note ${from}–${through}.`,
            model: options.model,
          });
        }

        yield* harness.notes.appendMemory(session.id, {
          parent: undefined,
          throughNote: 2,
          text: "Everything so far.",
          model: options.model,
        });

        const agent = yield* harness.startAgentUsing(
          [checkpointReply("cp"), textReply("Done.")],
          quietNotes,
        );

        const opened = yield* agent.open(Option.some(session.id), harness.directory);
        expect(runEnd(yield* prompt(opened, "Continue."))?.reason).toBe("answered");

        const details = checkpointDetails(yield* harness.sessions.entries(session.id, 0));
        expect(details).toMatchObject({ memory: 1, notes: [], tailFrom: 5 });

        const texts = userTexts(harness.prompts[1]);
        expect(texts[0]).toBe("Session memory of entries 1–4:\nEverything so far.");
        expect(texts[1]).toBe("Continue.");
        expect(promptText(harness.prompts[1])).not.toContain("Request 2");
      }),
    ));
});
