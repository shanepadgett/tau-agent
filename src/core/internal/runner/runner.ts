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
  Ref,
  Schedule,
  type Scope,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import {
  makeProcessSessions,
  PROCESS_LIMITS,
  type ProcessSessions,
  type ProcessSummary,
} from "../../../proc/ProcessSessions.ts";
import type { ModelRef } from "../../../ai/Catalog.ts";
import { ConversationId } from "../../../ai/ConversationId.ts";
import type { Models } from "../../../ai/Models.ts";
import type { WriteQueue } from "../../../sandbox/WriteQueue.ts";
import type { Entry, RunningProcess, SessionId } from "../../../session/Entry.ts";
import type { SessionStoreError } from "../../../session/SessionStoreError.ts";
import type { Session, Sessions } from "../../../session/Sessions.ts";
import type { SkillUses } from "../../../session/SkillUses.ts";
import type { AgentEvent, Command, RunEnd, SavedModel } from "../../Client.ts";
import type { ContextMethod } from "../../ContextMethod.ts";
import { historyFunction } from "../context/history.ts";
import { historyEvents, replyProfiles } from "./history-events.ts";
import { PROCESS_GROUP, processFunctions } from "../process/process-functions.ts";
import { WEB_GROUP, webFunctions } from "../web/web-functions.ts";
import type { Web } from "../../Web.ts";
import type { References } from "../../References.ts";
import { type SessionReferences, sessionReferences } from "../references/references-source.ts";
import { processNotices } from "../process/process-notices.ts";
import type { UserInstructions } from "../../UserInstructions.ts";
import type { OutputFolder } from "../../OutputFolder.ts";
import { makeOutputFiles, OutputFiles } from "../output/output-files.ts";
import type { Commits, CommitSettings } from "../../Commits.ts";
import { makeCommits } from "../commit/commits.ts";
import { checksTool } from "../checks/checks-tool.ts";
import { type ProjectChecks, readProjectChecks } from "../checks/checks-file.ts";
import type { RunContext } from "../loop/run-context.ts";
import { projectFolders } from "../instructions/folders.ts";
import { instructionsUpdate } from "../instructions/instructions.ts";
import { FileProblems, type RunFileProblems } from "../instructions/file-problems.ts";
import { instructionSources } from "../instructions/sources.ts";
import { runSteps } from "../loop/step.ts";
import { runTool, scriptFunctions, type Timeouts } from "../run-tool/run-tool.ts";
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
  /** Starts the record of the skill and instruction files a run could not use. */
  readonly fileProblems: Effect.Effect<RunFileProblems>;
  readonly commitSettings: CommitSettings;
  readonly web: Web["Service"];
  readonly references: References["Service"];
};

/** A session opened for runs. */
export type OpenSession = {
  readonly session: Session;
  /** Events of the session from now on. Subscribe before sending, to miss nothing. */
  readonly subscribe: Effect.Effect<PubSub.Subscription<AgentEvent>, never, Scope.Scope>;
  readonly send: (command: Command) => Effect.Effect<void>;
  /** The saved runs of the session as events, oldest first, for a client that shows a resumed chat. */
  readonly history: Effect.Effect<readonly AgentEvent[], SessionStoreError>;
  /** The model and thinking level of the session's latest reply, for a resumed chat to go on with. */
  readonly lastModel: Effect.Effect<SavedModel | undefined, SessionStoreError>;
  /** The steps of `/commit` in the session's repository. */
  readonly commits: Commits;
  /** The reference repositories attached to the session. */
  readonly references: SessionReferences;
};

type QueuedPrompt = Extract<Command, { type: "prompt" | "steer" }>;

/**
 * The steering messages waiting for the next model call of the running prompt, or none when no
 * prompt is running.
 */
type Steering = Option.Option<readonly QueuedPrompt[]>;

/** Starts the runner of session `id`. It stops, with its running prompt, when its scope closes. */
export const makeRunner = Effect.fn("makeRunner")(function* (services: RunServices, id: SessionId) {
  const session = yield* services.sessions.get(id);
  const events = yield* PubSub.unbounded<AgentEvent>();
  const annotated = Effect.annotateLogs({ session: id });
  yield* services.contextMethod.background(id, events).pipe(annotated);
  const prompts = yield* Queue.unbounded<QueuedPrompt>();
  const steering = yield* Ref.make<Steering>(Option.none());
  const current = yield* FiberHandle.make<RunEnd, unknown>();

  const processes = yield* sessionProcesses(services, events);

  const runNext = Effect.gen(function* () {
    const prompt = yield* Queue.take(prompts);
    yield* Ref.set(steering, Option.some([]));
    const runs: SessionRuns = { services, session, processes, events, steering };

    // The handle must hold the fiber before it starts: a run can publish an event, and a client
    // can cancel in answer, before a fiber that starts at once is handed back.
    const run = yield* FiberHandle.run(current, runPrompt(runs, prompt), {
      startImmediately: false,
    });

    yield* endRun(runs, yield* Fiber.await(run));

    // A steering message sent after the run's last model call runs as the next prompt.
    const left = yield* Ref.getAndSet(steering, Option.none());

    yield* Queue.offerAll(
      prompts,
      Option.getOrElse(left, () => []),
    );
  });

  yield* Effect.forkScoped(Effect.forever(runNext).pipe(annotated));

  const cancel = Effect.gen(function* () {
    const waiting = [...(yield* takeSteering(steering)), ...(yield* Queue.clear(prompts))];

    if (waiting.length > 0) {
      const returned = waiting.map((prompt) => prompt.text);
      yield* PubSub.publish(events, { type: "prompts-returned", prompts: returned });
    }

    yield* FiberHandle.clear(current);
  });

  /** A steering message waits for the running prompt's next model call; with no run, it is a prompt. */
  const steer = (command: QueuedPrompt) =>
    Ref.modify(steering, (state): [boolean, Steering] =>
      Option.isSome(state) ? [true, Option.some([...state.value, command])] : [false, state],
    ).pipe(
      Effect.flatMap((steered) => (steered ? Effect.void : Queue.offer(prompts, command))),
      Effect.asVoid,
    );

  const send = (command: Command) => {
    switch (command.type) {
      case "cancel":
        return cancel;
      case "steer":
        return steer(command);
      case "prompt":
        return Queue.offer(prompts, command).pipe(Effect.asVoid);
    }
  };

  const opened: OpenSession = {
    session,
    subscribe: PubSub.subscribe(events),
    send,
    ...savedRuns(services, id),
    commits: commitsOf(services, session),
    references: sessionReferences(services.sessions, id, events),
  };

  return opened;
});

/** Takes the waiting steering messages, and leaves the running prompt with none. */
const takeSteering = (steering: Ref.Ref<Steering>) =>
  Ref.modify(steering, (state): [readonly QueuedPrompt[], Steering] => [
    Option.getOrElse(state, () => []),
    Option.map(state, () => []),
  ]);

/** What the runs of one session share: its services, its commands and its event stream. */
type SessionRuns = {
  readonly services: RunServices;
  readonly session: Session;
  readonly processes: ProcessSessions;
  readonly events: PubSub.PubSub<AgentEvent>;
  readonly steering: Ref.Ref<Steering>;
};

/** Saves the prompt and runs the agent loop on it. */
const runPrompt = (
  { services, session, processes, events, steering }: SessionRuns,
  prompt: QueuedPrompt,
) =>
  Effect.gen(function* () {
    const { sessions, models } = services;
    const { timeouts, maxTurns, thinking } = prompt.options;
    // The reply saves the level with its model, so a resumed chat goes on at the same level.
    const model = { ...prompt.options.model, thinking };
    yield* sessions.append(session.id, [{ type: "user", text: prompt.text }]);
    yield* PubSub.publish(events, { type: "run-started", prompt: prompt.text });
    const { root, folders } = yield* projectFolders(session.directory);
    const files = yield* services.fileProblems;
    const withProblems = Effect.provideService(FileProblems, files.problems);
    const skills = yield* runSkills(services, session.directory, folders).pipe(withProblems);
    const checks = yield* readProjectChecks(session.directory, root);
    const user = services.userInstructions;

    const method = yield* services.contextMethod.forRun(
      session.id,
      model,
      processes.list.pipe(Effect.map(runningProcesses)),
    );

    const run = runToolOf(
      { services, session, processes, model: prompt.options.model },
      skills.skills,
      timeouts,
      checks,
    );

    const context: RunContext<Platform> = {
      session: session.id,
      model,
      profile: yield* models.profile(model),
      languageModel: yield* models.languageModel(model, ConversationId.make(session.id), thinking),
      sessions,
      tools: [run, ...Option.toArray(Option.flatMap(checks, checksTool)), ...method.tools],
      view: method.view,
      nudge: method.nudge,
      contextOperations: method.operations,
      shouldReply: method.shouldReply,
      checks,
      updateInstructions: (entries) =>
        instructionSources(
          { directory: session.directory, user, skills, references: services.references },
          entries,
        ).pipe(
          Effect.flatMap((sources) => instructionsUpdate(sources, entries)),
          withProblems,
          Effect.tap(files.show),
        ),
      processNotices: processNotices(processes),
      takeSteering: takeSteering(steering).pipe(
        Effect.map((steered) => steered.map(({ text }) => text)),
      ),
      maxTurns,
      emit: (event) => PubSub.publish(events, event).pipe(Effect.asVoid),
    };

    return yield* runSteps(context);
  }).pipe(withPlatform(services, session.id));

/** The `run` tool of one run, with the functions its scripts can call. */
const runToolOf = (
  {
    services,
    session,
    processes,
    model,
  }: Pick<SessionRuns, "services" | "session" | "processes"> & { readonly model: ModelRef },
  skills: readonly Skill[],
  timeouts: Timeouts,
  checks: Option.Option<ProjectChecks>,
) => {
  const used = (skill: Skill) => services.skillUses.record(skill.name, session.directory);

  return runTool<Platform>(
    (touched) => ({
      ...scriptFunctions(session.directory, timeouts, touched, services.writeQueue),
      history: historyFunction(session.id, services.sessions),
      [PROCESS_GROUP]: processFunctions(processes, session.directory),
      [WEB_GROUP]: webFunctions(services.web, model, ConversationId.make(`${session.id}:web`)),
      [SKILLS_GROUP]: skillFunctions(skills, touched, used),
    }),
    timeouts,
    checks,
  );
};

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

/** What a client reads of the session's saved runs when it opens the session. */
const savedRuns = (services: RunServices, id: SessionId) => ({
  history: Effect.gen(function* () {
    const entries = yield* services.sessions.entries(id, 0);
    const background = yield* services.contextMethod.history(id);

    return [
      ...historyEvents(entries, yield* replyProfiles(services.models, entries)),
      ...background,
    ];
  }),
  lastModel: services.sessions.entries(id, 0).pipe(Effect.map(lastReplyModel)),
});

const lastReplyModel = (entries: readonly Entry[]) => {
  const reply = entries.findLast(({ body }) => body.type === "assistant")?.body;
  return reply?.type === "assistant" ? reply.model : undefined;
};

/**
 * The session's process sessions. A command can exit at any time, and process sessions tell no
 * one, so the runner looks four times a second and publishes the list when it changed.
 */
const sessionProcesses = Effect.fn("sessionProcesses")(function* (
  services: RunServices,
  events: PubSub.PubSub<AgentEvent>,
) {
  const processes = yield* makeProcessSessions(PROCESS_LIMITS).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, services.spawner),
  );

  const shown = yield* Ref.make("[]");

  const publishChange = (list: readonly ProcessSummary[]) =>
    Ref.getAndSet(shown, JSON.stringify(list)).pipe(
      Effect.flatMap((before) =>
        before === JSON.stringify(list)
          ? Effect.void
          : PubSub.publish(events, { type: "processes-changed", processes: list }),
      ),
    );

  const look = processes.list.pipe(Effect.flatMap(publishChange));
  yield* Effect.forkScoped(look.pipe(Effect.repeat(Schedule.spaced(PROCESS_LOOK_INTERVAL))));
  return processes;
});

const PROCESS_LOOK_INTERVAL = "250 millis";

const runningProcesses = (summaries: readonly ProcessSummary[]): readonly RunningProcess[] =>
  summaries.flatMap(({ id, command, pty, state }) =>
    state.type === "running" ? [{ id, command, pty }] : [],
  );

/**
 * A failed run goes to the log with its whole cause, and into the session, so a resumed chat shows
 * it and the next model call knows about it.
 */
const endRun = Effect.fn("endRun")(function* (runs: SessionRuns, exit: Exit.Exit<RunEnd, unknown>) {
  const ended = runEnded(exit);

  if (Exit.isFailure(exit) && ended.type === "run-ended" && ended.reason === "failed") {
    yield* Effect.logError("The run failed", exit.cause);

    yield* runs.services.sessions
      .append(runs.session.id, [{ type: "run-failed", error: ended.error }])
      .pipe(Effect.catch((error) => Effect.logError("Could not save the failed run", error)));
  }

  yield* PubSub.publish(runs.events, ended);
});

const runEnded = (exit: Exit.Exit<RunEnd, unknown>): AgentEvent => {
  if (Exit.isSuccess(exit)) return { type: "run-ended", ...exit.value };

  if (Cause.hasInterruptsOnly(exit.cause)) return { type: "run-ended", reason: "cancelled" };

  return { type: "run-ended", reason: "failed", error: failureText(exit.cause) };
};

const commitsOf = (services: RunServices, session: Session) =>
  makeCommits(
    { sessions: services.sessions, models: services.models, settings: services.commitSettings },
    session,
    (effect) => effect.pipe(withPlatform(services, session.id)),
  );

/** Provides what tools, checks and `/commit` run on. */
const withPlatform =
  (services: RunServices, session: SessionId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, services.fileSystem),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, services.spawner),
      Effect.provideService(
        OutputFiles,
        makeOutputFiles(services.outputFolder, session, services.fileSystem, services.crypto),
      ),
    );
