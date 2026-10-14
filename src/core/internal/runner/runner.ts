/**
 * The runner of one session: it takes prompts in order and runs one at a time, so a session has
 * one writer. A cancel stops the running prompt and gives back the waiting ones.
 */

import { join } from "node:path";
import {
  Cause,
  type Crypto,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  FileSystem,
  Option,
  PubSub,
  Queue,
  type Scope,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import { ConversationId } from "../../../ai/ConversationId.ts";
import type { Models } from "../../../ai/Models.ts";
import type { WriteQueue } from "../../../sandbox/WriteQueue.ts";
import type { SessionId } from "../../../session/Entry.ts";
import type { Session, Sessions } from "../../../session/Sessions.ts";
import type { SkillUses } from "../../../session/SkillUses.ts";
import type { AgentEvent, Command, RunEnd } from "../../Client.ts";
import type { ContextMethod } from "../../ContextMethod.ts";
import { historyFunction } from "../context/history.ts";
import type { UserInstructions } from "../../UserInstructions.ts";
import type { OutputFolder } from "../../OutputFolder.ts";
import { makeOutputFiles, OutputFiles } from "../output/output-files.ts";
import { checksTool } from "../checks/checks-tool.ts";
import { readProjectChecks } from "../checks/checks-file.ts";
import type { RunContext } from "../loop/run-context.ts";
import { projectFolders } from "../instructions/folders.ts";
import { instructionsUpdate } from "../instructions/instructions.ts";
import { instructionSources } from "../instructions/sources.ts";
import { runSteps } from "../loop/step.ts";
import { runTool, scriptFunctions } from "../run-tool/run-tool.ts";
import { findSkills, type Skill, SKILLS_GROUP, skillFunctions } from "../skills/skills.ts";
import type { Platform } from "../tools/model-tool.ts";
import { failureText } from "./failure-text.ts";

export type RunServices = {
  readonly sessions: Sessions["Service"];
  readonly models: Models["Service"];
  readonly contextMethod: ContextMethod["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly userInstructions: UserInstructions["Service"];
  readonly skillUses: SkillUses["Service"];
  readonly outputFolder: OutputFolder["Service"];
  readonly crypto: Crypto.Crypto;
  /** Shared by every session of the process, so their writes to one file wait for each other. */
  readonly writeQueue: WriteQueue;
};

/** A session opened for runs. */
export type OpenSession = {
  readonly session: Session;
  /** Events of the session from now on. Subscribe before sending, to miss nothing. */
  readonly subscribe: Effect.Effect<PubSub.Subscription<AgentEvent>, never, Scope.Scope>;
  readonly send: (command: Command) => Effect.Effect<void>;
};

type QueuedPrompt = Extract<Command, { type: "prompt" }>;

/** Starts the runner of session `id`. It stops, with its running prompt, when its scope closes. */
export const makeRunner = Effect.fn("makeRunner")(function* (services: RunServices, id: SessionId) {
  const session = yield* services.sessions.get(id);
  const events = yield* PubSub.unbounded<AgentEvent>();
  yield* services.contextMethod.background(id, PubSub.subscribe(events));
  const prompts = yield* Queue.unbounded<QueuedPrompt>();
  const current = yield* FiberHandle.make<RunEnd, unknown>();

  const runNext = Effect.gen(function* () {
    const prompt = yield* Queue.take(prompts);

    // The handle must hold the fiber before it starts: a run can publish an event, and a client
    // can cancel in answer, before a fiber that starts at once is handed back.
    const run = yield* FiberHandle.run(current, runPrompt(services, session, prompt, events), {
      startImmediately: false,
    });

    yield* PubSub.publish(events, runEnded(yield* Fiber.await(run)));
  });

  yield* Effect.forkScoped(Effect.forever(runNext));

  const cancel = Effect.gen(function* () {
    const waiting = yield* Queue.clear(prompts);

    if (waiting.length > 0) {
      const returned = waiting.map((prompt) => prompt.text);
      yield* PubSub.publish(events, { type: "prompts-returned", prompts: returned });
    }

    yield* FiberHandle.clear(current);
  });

  const send = (command: Command) =>
    command.type === "cancel" ? cancel : Queue.offer(prompts, command).pipe(Effect.asVoid);

  const opened: OpenSession = { session, subscribe: PubSub.subscribe(events), send };
  return opened;
});

/** Saves the prompt and runs the agent loop on it. */
const runPrompt = (
  services: RunServices,
  session: Session,
  prompt: QueuedPrompt,
  events: PubSub.PubSub<AgentEvent>,
) =>
  Effect.gen(function* () {
    const { sessions, models } = services;
    const { model, timeouts, maxTurns } = prompt.options;
    yield* sessions.append(session.id, [{ type: "user", text: prompt.text }]);
    const { root, folders } = yield* projectFolders(session.directory);
    const skills = yield* runSkills(services, session.directory, folders);
    const checks = yield* readProjectChecks(session.directory, root);
    const used = (skill: Skill) => services.skillUses.record(skill.name, session.directory);
    const user = services.userInstructions;
    const method = yield* services.contextMethod.forRun(session.id, model);

    const run = runTool<Platform>(
      (touched) => ({
        ...scriptFunctions(session.directory, timeouts, touched, services.writeQueue),
        history: historyFunction(session.id, sessions),
        [SKILLS_GROUP]: skillFunctions(skills.skills, touched, used),
      }),
      timeouts,
      checks,
    );

    const context: RunContext<Platform> = {
      session: session.id,
      model,
      languageModel: yield* models.languageModel(model, ConversationId.make(session.id)),
      sessions,
      tools: [run, ...Option.toArray(Option.flatMap(checks, checksTool)), ...method.tools],
      view: method.view,
      nudge: method.nudge,
      contextOperations: method.operations,
      shouldReply: method.shouldReply,
      checks,
      updateInstructions: (entries) =>
        instructionSources({ directory: session.directory, user, skills }, entries).pipe(
          Effect.flatMap((sources) => instructionsUpdate(sources, entries)),
        ),
      maxTurns,
      emit: (event) => PubSub.publish(events, event).pipe(Effect.asVoid),
    };

    return yield* runSteps(context);
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, services.fileSystem),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, services.spawner),
    Effect.provideService(
      OutputFiles,
      makeOutputFiles(services.outputFolder, session.id, services.fileSystem, services.crypto),
    ),
  );

/** The skills are found once per run; a skill added during a run is seen by the next one. */
const runSkills = Effect.fn("runSkills")(function* (
  services: RunServices,
  directory: string,
  folders: readonly string[],
) {
  const skills = yield* findSkills({
    user: services.userInstructions.skillFolders,
    project: folders.flatMap((folder) => [
      join(folder, ".agents", "skills"),
      join(folder, ".tau", "skills"),
    ]),
  });

  return { skills, ranking: yield* services.skillUses.ranking(directory) };
});

const runEnded = (exit: Exit.Exit<RunEnd, unknown>): AgentEvent => {
  if (Exit.isSuccess(exit)) return { type: "run-ended", ...exit.value };

  if (Cause.hasInterruptsOnly(exit.cause)) return { type: "run-ended", reason: "cancelled" };

  return { type: "run-ended", reason: "failed", error: failureText(exit.cause) };
};
