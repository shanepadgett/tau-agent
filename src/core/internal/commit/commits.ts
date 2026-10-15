/** Builds the `/commit` steps of one session, on git, the project's checks and the small model. */

import { DateTime, Effect, type FileSystem, Option } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { ModelRef } from "../../../ai/Catalog.ts";
import { ConversationId } from "../../../ai/ConversationId.ts";
import type { Models } from "../../../ai/Models.ts";
import { checkReportText } from "../../../session/CheckReport.ts";
import type { Session } from "../../../session/Sessions.ts";
import type { Sessions } from "../../../session/Sessions.ts";
import * as Git from "../../../workspace/Git.ts";
import { repositoryRoot } from "../../../workspace/Repository.ts";
import {
  type CommitChecks,
  CommitError,
  CommitFailed,
  type Commits,
  type CommitSettings,
  type CommitStart,
  type PlannedCommit,
} from "../../Commits.ts";
import type { ProjectChecks } from "../checks/checks-file.ts";
import { readProjectChecks } from "../checks/checks-file.ts";
import { dueChecks, runChecks } from "../checks/run-checks.ts";
import type { OutputFiles } from "../output/output-files.ts";
import { planCommits } from "./commit-plan.ts";

const RECENT_SUBJECTS = 12;
const THINKING = "high";

/** What the steps run on, which the runner provides. */
type CommitPlatform = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | OutputFiles;

type CommitServices = {
  readonly sessions: Sessions["Service"];
  readonly models: Models["Service"];
  readonly settings: CommitSettings;
};

type Provide = <A, E>(effect: Effect.Effect<A, E, CommitPlatform>) => Effect.Effect<A, E>;

const failWith = (error: { readonly message: string }) =>
  new CommitError({ message: error.message });

/**
 * `provide` gives the steps the services checks need, such as the file system and the output files.
 */
export const makeCommits = (
  services: CommitServices,
  session: Session,
  provide: Provide,
): Commits => ({
  settings: services.settings,
  start: provide(startOf(session)).pipe(Effect.mapError(failWith)),
  checkCount: (start) =>
    provide(dueOf(session, start)).pipe(
      Effect.map((due) => due.length),
      Effect.mapError(failWith),
    ),
  check: (start) => provide(checkOf(session, start)).pipe(Effect.mapError(failWith)),
  planModel: (chatModel) => services.models.smallModel(chatModel).pipe(Effect.mapError(failWith)),
  plan: (start, model, instruction) =>
    provide(planOf({ services, session, start, model, instruction })).pipe(
      Effect.mapError(failWith),
    ),
  commit: (start, plan, onCommit) => provide(commitAll(start, plan, onCommit)),
  pushTarget: (start) => provide(Git.pushTarget(start.root)).pipe(Effect.mapError(failWith)),
  push: (start, target) => provide(Git.push(start.root, target)).pipe(Effect.mapError(failWith)),
});

const startOf = Effect.fn("startOf")(function* (session: Session) {
  const root = yield* repositoryRoot(session.directory);
  if (Option.isNone(root)) return Option.none<CommitStart>();
  const files = yield* Git.changedFiles(root.value);
  return Option.some({ root: root.value, files });
});

/** The `check` and `commit` checks that apply to the changed files. */
const dueOf = (session: Session, start: CommitStart) =>
  readProjectChecks(session.directory, Option.some(start.root)).pipe(
    Effect.map(Option.match({ onNone: () => [], onSome: listsToRun })),
    Effect.flatMap((checks) =>
      dueChecks(checks, start.root, { type: "files", paths: start.files.map(({ path }) => path) }),
    ),
  );

const checkOf = Effect.fn("checkOf")(function* (
  session: Session,
  start: CommitStart,
): Effect.fn.Return<CommitChecks, CheckFailure, CommitPlatform> {
  const report = yield* runChecks(yield* dueOf(session, start));
  const after = yield* Git.changedFiles(start.root);
  if (statusText(after) !== statusText(start.files)) return { type: "changed" };
  if (report.failed.length === 0) return { type: "passed" };
  const names = report.failed.map(({ name }) => name);

  const failed: CommitChecks = {
    type: "failed",
    names,
    prompt: failurePrompt(checkReportText(report)),
  };

  return failed;
});

const planOf = Effect.fn("planOf")(function* (request: {
  readonly services: CommitServices;
  readonly session: Session;
  readonly start: CommitStart;
  readonly model: ModelRef;
  readonly instruction: string;
}) {
  const { services, session, start } = request;

  const languageModel = yield* services.models.languageModel(
    request.model,
    ConversationId.make(`${session.id}:commit`),
    THINKING,
  );

  return yield* planCommits(languageModel, {
    files: start.files,
    diff: yield* Git.diffText(start.root, start.files),
    subjects: yield* Git.recentSubjects(start.root, RECENT_SUBJECTS),
    prompts: yield* promptsSince(services.sessions, session, start.root),
    instruction: request.instruction,
    avoidBreakingChanges: services.settings.avoidBreakingChanges,
  });
});

type CheckFailure = Effect.Error<ReturnType<typeof dueOf>> | Git.GitFailed;

const listsToRun = (checks: ProjectChecks) => [...checks.check, ...checks.commit];

const statusText = (files: readonly Git.ChangedFile[]) =>
  files.map((file) => `${file.status} ${file.path}`).join("\n");

const failurePrompt = (report: string) =>
  `[commit checks] /commit ran the project's checks and some failed, so nothing was committed. Fix these, then I will run /commit again.\n\n${report}`;

/** The user's prompts in this session after the repository's latest commit. */
const promptsSince = Effect.fn("promptsSince")(function* (
  sessions: Sessions["Service"],
  session: Session,
  root: string,
) {
  const since = Option.getOrElse(yield* Git.headTime(root), () => 0);
  const entries = yield* sessions.entries(session.id, 0);

  return entries.flatMap(({ at, body }) =>
    body.type === "user" && DateTime.toEpochMillis(at) > since ? [body.text] : [],
  );
});

const commitAll = Effect.fn("commitAll")(function* (
  start: CommitStart,
  plan: readonly PlannedCommit[],
  onCommit: (index: number) => void,
) {
  const hashes: string[] = [];

  for (const [index, planned] of plan.entries()) {
    onCommit(index);

    const paths = planned.files.flatMap(({ path, previousPath }) =>
      previousPath === undefined ? [path] : [path, previousPath],
    );

    const hash = yield* Git.commitFiles(start.root, paths, planned.message).pipe(
      Effect.mapError((error) => new CommitFailed({ hashes, message: error.message })),
    );

    hashes.push(hash);
  }

  return hashes;
});
