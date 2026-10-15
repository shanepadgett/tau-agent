import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Context, Deferred, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { AiError, type Response } from "effect/ai";
import { CompactionSettings, ContextSettings } from "../../src/core/ContextSettings.ts";
import { TauHome } from "../../src/database/TauHome.ts";
import { Settings } from "../../src/host/Settings.ts";
import { Memories } from "../../src/session/Memories.ts";
import { Sessions } from "../../src/session/Sessions.ts";
import { transcript } from "../../src/session/Transcript.ts";
import {
  options,
  profile,
  prompt,
  isRunEnd,
  runEnd,
  runReply,
  textReply,
  takeUntil,
  toolResults,
  userTexts,
  withHarness,
} from "../support/agent-harness.ts";
import {
  assistant,
  checkpointReply,
  contextLayer,
  counted,
  promptText,
  provider,
  waitForNotes,
} from "../support/compaction.ts";

describe("compaction", () => {
  test("settings supply compaction defaults and read the user's selected method and thresholds", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const settings = Settings.layer.pipe(Layer.provide(TauHome.at(`${harness.home}/.tau`)));
        const defaults = yield* Layer.build(settings);
        expect(Context.get(defaults, ContextSettings)).toEqual({});
        const fileSystem = yield* FileSystem.FileSystem;

        const compaction: CompactionSettings = {
          method: "off",
          budgetTokens: 80000,
          notesStartTokens: 20000,
        };

        yield* fileSystem.writeFileString(
          `${harness.home}/.tau/settings.json`,
          Schema.encodeSync(
            Schema.fromJsonString(Schema.Struct({ compaction: CompactionSettings })),
          )({ compaction }),
        );

        const configured = yield* Layer.build(settings);
        expect(Context.get(configured, ContextSettings)).toEqual(compaction);
      }),
    ));

  test.each([
    { field: "budgetTokens", value: 0 },
    { field: "notesStartTokens", value: 1.5 },
    { field: "method", value: "summary" },
  ])("settings reject an invalid compaction.$field", ({ field, value }) =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = `${harness.home}/.tau/settings.json`;

        yield* fileSystem.writeFileString(
          path,
          Schema.encodeSync(Schema.fromJsonString(Schema.Json))({ compaction: { [field]: value } }),
        );

        const settings = Settings.layer.pipe(Layer.provide(TauHome.at(`${harness.home}/.tau`)));
        const error = yield* Layer.build(settings).pipe(Effect.flip);
        if (error._tag !== "SettingsInvalid") return yield* Effect.fail(error);
        expect(error.path).toBe(path);
        expect(error.message).toContain(field);
      }),
    ),
  );

  test("checkpoints pin notes, preserve the raw tail and keep the old note prefix on the next checkpoint", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* harness.sessions.create(harness.directory);

        yield* harness.sessions.append(session.id, [
          { type: "user", text: "Old raw request." },
          assistant("Old raw answer."),
          { type: "user", text: "Recent request." },
        ]);

        yield* harness.notes.appendShortTerm(session.id, {
          from: 1,
          through: 2,
          text: "The first saved note.",
          model: options.model,
        });

        const agent = yield* harness.startAgentUsing(
          [
            checkpointReply("cp1"),
            textReply("First checkpoint done."),
            textReply("Still working."),
            checkpointReply("cp2", "Continue from the second checkpoint."),
            textReply("Done."),
          ],
          contextLayer({ notesStartTokens: 1000000 }),
        );

        const opened = yield* agent.open(Option.some(session.id), harness.directory);
        expect(runEnd(yield* prompt(opened, "Continue."))?.reason).toBe("answered");
        expect(promptText(harness.prompts[1])).toContain("The first saved note.");
        expect(promptText(harness.prompts[1])).not.toContain("Old raw request.");
        expect(promptText(harness.prompts[1])).toContain("Recent request.");
        expect(promptText(harness.prompts[1])).toContain("Your handoff at the checkpoint");

        yield* harness.notes.appendShortTerm(session.id, {
          from: 3,
          through: 4,
          text: "The second saved note.",
          model: options.model,
        });

        yield* prompt(opened, "More work.");
        expect(promptText(harness.prompts[2])).not.toContain("The second saved note.");
        yield* prompt(opened, "Checkpoint again.");
        expect(promptText(harness.prompts[4])).toContain("The second saved note.");

        // Cache marks move to the new last note; the cached role and content stay the same.
        expect(
          harness.prompts[4]?.content.slice(0, 2).map(({ role, content }) => ({ role, content })),
        ).toEqual(
          harness.prompts[1]?.content.slice(0, 2).map(({ role, content }) => ({ role, content })),
        );

        expect(
          harness.prompts[4]?.content.some(
            (message) =>
              message.role === "tool" &&
              message.content.some((part) => part.type === "tool-result" && part.isFailure),
          ),
        ).toBe(false);
      }),
    ));

  test("forced context blocks tools without changing the toolkit, then a checkpoint enables them", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* harness.sessions.create(harness.directory);

        yield* harness.sessions.append(session.id, [
          { type: "user", text: "Earlier work." },
          assistant("Earlier answer."),
        ]);

        yield* harness.notes.appendShortTerm(session.id, {
          from: 1,
          through: 2,
          text: "Earlier work completed.",
          model: options.model,
        });

        const agent = yield* harness.startAgentUsing(
          [
            counted(
              runReply(
                "blocked",
                'await tools.write({ path: "blocked.txt", content: "must not happen" })',
              ),
              1000,
              900,
            ),
            checkpointReply("cp"),
            runReply("allowed", 'await tools.write({ path: "allowed.txt", content: "done" })'),
            textReply("Done."),
          ],
          contextLayer({ budgetTokens: 1000, notesStartTokens: 1000000 }),
        );

        const opened = yield* agent.open(Option.some(session.id), harness.directory);
        expect(runEnd(yield* prompt(opened, "Work."))?.reason).toBe("answered");
        const fileSystem = yield* FileSystem.FileSystem;
        expect(yield* fileSystem.exists(`${harness.directory}/blocked.txt`)).toBe(false);
        expect(yield* fileSystem.readFileString(`${harness.directory}/allowed.txt`)).toBe("done");

        expect(toolResults(harness.prompts[1]).at(-1)).toContain(
          "All tools except checkpoint are blocked",
        );

        expect(
          userTexts(harness.prompts[1]).some((text) =>
            text.includes("All tools except checkpoint are blocked"),
          ),
        ).toBe(true);

        expect(new Set(harness.tools).size).toBe(1);
        const saved = yield* harness.sessions.entries(session.id, 0);

        expect(
          saved.filter(({ body }) => body.type === "nudge" && body.key === "context-stage:forced"),
        ).toHaveLength(1);
      }),
    ));

  test("notice and warning are saved once each and cache counts are not added to total input", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgentUsing(
          [
            counted(runReply("one", 'console.log("one")'), 1200, 1200),
            counted(runReply("two", 'console.log("two")'), 2200, 2000),
            counted(runReply("three", 'console.log("three")'), 2300, 2000),
            counted(runReply("four", 'console.log("four")'), 3200, 3000),
            textReply("Done."),
          ],
          contextLayer({ budgetTokens: 4000, notesStartTokens: 1000000 }),
        );

        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Work.");

        expect(
          userTexts(harness.prompts[1]).some((text) => text.startsWith("Context notice")),
        ).toBe(false);

        const entries = yield* harness.sessions.entries(opened.session.id, 0);

        expect(entries.flatMap(({ body }) => (body.type === "nudge" ? [body.key] : []))).toEqual([
          "context-stage:notice",
          "context-stage:warning",
        ]);
      }),
    ));

  test("the note writer receives full user, assistant and tool messages, instructions and nudges in a complete range", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* harness.sessions.create(harness.directory);
        const output = `START-OUTPUT ${"x".repeat(70000)} END-OUTPUT`;

        const entries = yield* harness.sessions.append(session.id, [
          { type: "user", text: "Keep this exact request." },
          {
            type: "assistant",
            model: options.model,
            interrupted: false,
            parts: [
              { type: "text", text: "Assistant explanation.", providerData: {} },
              {
                type: "tool-call",
                id: "raw-call",
                name: "run",
                params: { code: "FULL-INPUT" },
                providerData: {},
              },
            ],
          },
          {
            type: "tool-result",
            callId: "raw-call",
            name: "run",
            result: output,
            isFailure: false,
          },
          {
            type: "instructions",
            placement: "update",
            values: { rule: "RULE" },
            text: "Instruction message.",
          },
          { type: "nudge", key: "test", text: "Hidden model message." },
          { type: "user", text: "Recent raw tail." },
        ]);

        const agent = yield* harness.startAgentUsing(
          [textReply("Done.")],
          contextLayer({ notesStartTokens: 1 }),
        );

        const opened = yield* agent.open(Option.some(session.id), harness.directory);
        const notes = yield* waitForNotes(harness.notes, session.id, 1);
        expect(notes[0]?.from).toBe(1);
        expect(notes[0]?.through).toBe(5);
        expect(notes[0]?.model.model).toBe(provider.smallModel);
        const received = userTexts(harness.notePrompts[0]).join("\n");

        for (const text of [
          "Keep this exact request.",
          "Assistant explanation.",
          "FULL-INPUT",
          output,
          "Instruction message.",
          "Hidden model message.",
        ])
          expect(received).toContain(text);

        expect(received).not.toContain("Recent raw tail.");
        expect(received).not.toContain("The call ended before it returned a result");
        expect(transcript(entries)).toContain(output);
        expect(runEnd(yield* prompt(opened, "Continue."))?.reason).toBe("answered");
      }),
    ));

  test("an announced forced stage blocks tools until checkpoint even when a later token report is smaller", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgentUsing(
          [
            counted(runReply("first", 'console.log("first")'), 4000),
            counted(runReply("second", 'console.log("second")'), 100),
            checkpointReply("cp"),
            runReply("third", 'console.log("third")'),
            textReply("Done."),
          ],
          contextLayer({ budgetTokens: 4000, notesStartTokens: 1000000 }),
        );

        const opened = yield* agent.open(Option.none(), harness.directory);
        expect(runEnd(yield* prompt(opened, "Work."))?.reason).toBe("answered");

        expect(toolResults(harness.prompts[2]).at(-1)).toContain(
          "All tools except checkpoint are blocked",
        );

        expect(toolResults(harness.prompts[4]).at(-1)).toBe("third");
        expect(new Set(harness.tools).size).toBe(1);
      }),
    ));

  test("tool output after a token report counts toward the context budget", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgentUsing(
          [
            counted(runReply("large", 'console.log("x".repeat(12000))'), 300),
            textReply("Checkpoint next."),
          ],
          contextLayer({ budgetTokens: 2000, notesStartTokens: 1000000 }),
        );

        const opened = yield* agent.open(Option.none(), harness.directory);
        const events = yield* opened.subscribe;

        yield* opened.send({
          type: "prompt",
          text: "Read the output.",
          options: { ...options, maxTurns: 2 },
        });

        expect(runEnd(yield* takeUntil(events, isRunEnd))?.reason).toBe("turn-limit");

        expect(
          userTexts(harness.prompts[1]).some((text) =>
            text.includes("All tools except checkpoint are blocked"),
          ),
        ).toBe(true);

        expect(toolResults(harness.prompts[1]).at(-1)).toContain("x".repeat(12000));
      }),
    ));

  test("notes fall back to the session model when the cheap model is not offered", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* harness.sessions.create(harness.directory);

        yield* harness.sessions.append(session.id, [
          { type: "user", text: "x".repeat(70000) },
          assistant("Recent reply."),
        ]);

        const agent = yield* harness.startAgentUsing(
          [],
          contextLayer({ notesStartTokens: 1 }, "missing"),
        );

        yield* agent.open(Option.some(session.id), harness.directory);

        expect((yield* waitForNotes(harness.notes, session.id, 1))[0]?.model).toEqual(
          options.model,
        );
      }),
    ));

  test("the writer saves successive whole-message ranges and keeps the latest reply raw", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* harness.sessions.create(harness.directory);
        const large = "x".repeat(70000);

        yield* harness.sessions.append(session.id, [
          { type: "user", text: large },
          assistant("First answer."),
          { type: "user", text: large },
          assistant("Second answer."),
          { type: "user", text: large },
          assistant("Latest raw answer."),
        ]);

        const agent = yield* harness.startAgentUsing([], contextLayer({ notesStartTokens: 1 }));
        yield* agent.open(Option.some(session.id), harness.directory);
        const notes = yield* waitForNotes(harness.notes, session.id, 3);

        expect(notes.map(({ from, through }) => [from, through])).toEqual([
          [1, 1],
          [2, 3],
          [4, 5],
        ]);

        expect(promptText(harness.notePrompts[1])).toContain("Earlier notes:");
        expect(promptText(harness.notePrompts[1])).toContain("Saved background note.");
        expect(promptText(harness.notePrompts[2])).not.toContain("Latest raw answer.");
      }),
    ));

  test.each(["failed", "empty"])(
    "a background note with %s output leaves entries intact and retries on the next run",
    (failure) =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const session = yield* harness.sessions.create(harness.directory);

          const entries = yield* harness.sessions.append(session.id, [
            { type: "user", text: "x".repeat(70000) },
            assistant("Recent reply."),
          ]);

          const finished = yield* Deferred.make<void>();

          const failed =
            failure === "empty"
              ? Effect.succeed<Response.PartEncoded[]>([])
              : Effect.fail(
                  AiError.make({
                    module: "test",
                    method: "note",
                    reason: new AiError.InvalidOutputError({
                      description: "Scripted note failure.",
                    }),
                  }),
                );

          const agent = yield* harness.startAgentUsing(
            [textReply("Main run finished.")],
            contextLayer({ notesStartTokens: 1 }),
            [failed.pipe(Effect.ensuring(Deferred.succeed(finished, undefined)))],
          );

          const opened = yield* agent.open(Option.some(session.id), harness.directory);
          yield* Deferred.await(finished);
          expect(yield* harness.notes.shortTerm(session.id)).toHaveLength(0);
          expect(yield* harness.sessions.entries(session.id, 0)).toEqual(entries);
          expect(runEnd(yield* prompt(opened, "Continue."))?.reason).toBe("answered");
          expect((yield* waitForNotes(harness.notes, session.id, 1))[0]?.from).toBe(1);
          expect(harness.notePrompts).toHaveLength(2);
        }),
      ),
  );

  test("closing the session cancels an unfinished note without blocking the main run, then reopening retries", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* harness.sessions.create(harness.directory);

        yield* harness.sessions.append(session.id, [
          { type: "user", text: "x".repeat(70000) },
          assistant("Recent reply."),
        ]);

        const started = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();

        const unfinished = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid)),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const agent = yield* harness.startAgentUsing(
              [textReply("Main run finished.")],
              contextLayer({ notesStartTokens: 1 }),
              [unfinished],
            );

            const opened = yield* agent.open(Option.some(session.id), harness.directory);
            yield* Deferred.await(started);
            expect(runEnd(yield* prompt(opened, "Continue."))?.reason).toBe("answered");
            expect(yield* harness.notes.shortTerm(session.id)).toHaveLength(0);
          }),
        );

        yield* Deferred.await(cancelled);
        expect(yield* harness.notes.shortTerm(session.id)).toHaveLength(0);
        const restarted = yield* harness.startAgentUsing([], contextLayer({ notesStartTokens: 1 }));
        yield* restarted.open(Option.some(session.id), harness.directory);
        expect((yield* waitForNotes(harness.notes, session.id, 1))[0]?.from).toBe(1);
      }),
    ));

  test("the first context estimate after checkpoint includes pinned notes instead of the checkpoint call", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* harness.sessions.create(harness.directory);

        yield* harness.sessions.append(session.id, [
          { type: "user", text: "Earlier work." },
          assistant("Earlier answer."),
        ]);

        yield* harness.notes.appendShortTerm(session.id, {
          from: 1,
          through: 2,
          text: "n".repeat(18000),
          model: options.model,
        });

        const agent = yield* harness.startAgentUsing(
          [
            counted(runReply("blocked", 'console.log("blocked")'), 6000),
            checkpointReply("cp"),
            textReply("Done."),
          ],
          contextLayer({ budgetTokens: 6000, notesStartTokens: 1000000 }),
        );

        const opened = yield* agent.open(Option.some(session.id), harness.directory);
        expect(runEnd(yield* prompt(opened, "Continue."))?.reason).toBe("answered");

        expect(userTexts(harness.prompts[2]).some((text) => text.includes("Context warning"))).toBe(
          true,
        );

        const entries = yield* harness.sessions.entries(session.id, 0);

        const checkpoint = entries.find(
          ({ body }) => body.type === "tool-result" && body.details?.tool === "checkpoint",
        );

        if (
          checkpoint?.body.type !== "tool-result" ||
          checkpoint.body.details?.tool !== "checkpoint"
        )
          throw new Error("The checkpoint result is saved.");

        expect(checkpoint.body.details.shortTermTokens).toBeGreaterThan(4500);

        expect(
          harness.prompts[2]?.content.some(
            (message) =>
              message.role === "assistant" &&
              message.content.some(
                (part) => part.type === "tool-call" && part.name === "checkpoint",
              ),
          ),
        ).toBe(false);
      }),
    ));

  test.each([
    {
      limit: "window",
      limits: { ...profile, contextTokens: 20000 },
      settings: {},
      stage: "notice",
    },
    {
      limit: "price",
      limits: {
        ...profile,
        longContextPrice: {
          aboveTokens: 3000,
          price: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
        },
      },
      settings: {},
      stage: "warning",
    },
    { limit: "setting", limits: profile, settings: { budgetTokens: 2000 }, stage: "forced" },
  ])("the $limit limits the context budget", ({ limits, settings, stage }) =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgentUsing(
          [
            counted(runReply("work", 'console.log("work")'), 2500),
            checkpointReply("cp"),
            textReply("Done."),
          ],
          contextLayer({ ...settings, notesStartTokens: 1000000 }, "available", limits),
        );

        const opened = yield* agent.open(Option.none(), harness.directory);
        expect(runEnd(yield* prompt(opened, "Work."))?.reason).toBe("answered");
        const entries = yield* harness.sessions.entries(opened.session.id, 0);

        expect(
          entries.some(
            ({ body }) => body.type === "nudge" && body.key === `context-stage:${stage}`,
          ),
        ).toBe(true);
      }),
    ),
  );

  test("forks copy only notes within the fork range and notes survive reopening the database", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* harness.sessions.create(harness.directory);

        yield* harness.sessions.append(session.id, [
          { type: "user", text: "One." },
          assistant("Two."),
          { type: "user", text: "Three." },
          assistant("Four."),
        ]);

        yield* harness.notes.appendShortTerm(session.id, {
          from: 1,
          through: 2,
          text: "One note.",
          model: options.model,
        });

        yield* harness.notes.appendShortTerm(session.id, {
          from: 3,
          through: 4,
          text: "Another note.",
          model: options.model,
        });

        const branch = yield* harness.sessions.fork(session.id, 3);

        const store = yield* Layer.build(
          Sessions.layer.pipe(
            Layer.provide(TauHome.at(`${harness.home}/.tau`)),
            Layer.provide(BunServices.layer),
          ),
        );

        const reopened = Context.get(store, Memories);

        expect((yield* reopened.shortTerm(branch.id)).map((note) => note.text)).toEqual([
          "One note.",
        ]);

        expect((yield* reopened.shortTerm(session.id)).map((note) => note.number)).toEqual([1, 2]);

        expect(
          (yield* reopened.appendShortTerm(branch.id, {
            from: 3,
            through: 3,
            text: "Branch note.",
            model: options.model,
          })).number,
        ).toBe(2);
      }),
    ));

  test("history can recall a note's full raw entries from a run script after a checkpoint", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* harness.sessions.create(harness.directory);

        yield* harness.sessions.append(session.id, [
          { type: "user", text: "Recall this exact request." },
          assistant("Recall this exact reply."),
        ]);

        yield* harness.notes.appendShortTerm(session.id, {
          from: 1,
          through: 2,
          text: "A summary.",
          model: options.model,
        });

        const agent = yield* harness.startAgentUsing(
          [
            checkpointReply("cp"),
            runReply("recall", "console.log(await tools.history({ from: 1, through: 2 }))"),
            textReply("Done."),
          ],
          contextLayer({ notesStartTokens: 1000000 }),
        );

        const opened = yield* agent.open(Option.some(session.id), harness.directory);
        yield* prompt(opened, "Recall.");
        const result = toolResults(harness.prompts[2]).at(-1);
        expect(result).toContain("Recall this exact request.");
        expect(result).toContain("Recall this exact reply.");
      }),
    ));

  test("a mixed checkpoint reply fails instead of dropping other calls", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const mixed = Stream.make<Response.StreamPartEncoded[]>(
          { type: "tool-call", id: "cp", name: "checkpoint", params: { handoff: "Work." } },
          {
            type: "tool-call",
            id: "run",
            name: "run",
            params: { code: 'console.log("still here")' },
          },
        );

        const agent = yield* harness.startAgentUsing(
          [mixed, textReply("Done.")],
          contextLayer({ notesStartTokens: 1000000 }),
        );

        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Work.");
        expect(toolResults(harness.prompts[1])[0]).toContain("Call checkpoint alone");
        expect(toolResults(harness.prompts[1])[1]).toBe("still here");
        const entries = yield* harness.sessions.entries(opened.session.id, 0);

        expect(
          entries.some(
            ({ body }) => body.type === "tool-result" && body.details?.tool === "checkpoint",
          ),
        ).toBe(false);
      }),
    ));

  test("off keeps the whole history and does not offer checkpoint", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgentUsing(
          [textReply("Done.")],
          contextLayer({ method: "off", budgetTokens: 1 }),
        );

        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Raw request.");
        expect(userTexts(harness.prompts[0])).toContain("Raw request.");
        expect(harness.tools[0]).not.toContain("Compact your context instantly");
        expect(harness.notePrompts).toHaveLength(0);

        expect(
          (yield* harness.sessions.entries(opened.session.id, 0)).some(
            ({ body }) => body.type === "nudge",
          ),
        ).toBe(false);
      }),
    ));
});
