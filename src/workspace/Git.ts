/**
 * The git reads and writes `/commit` needs: the changed files and their diffs, recent subjects,
 * committing a group of files, and pushing.
 */

import { Duration, Effect, Option, Schema } from "effect";
import { runProgramWith } from "../proc/Command.ts";
import { GIT_TIMEOUT } from "./Repository.ts";

/** Commits and pushes run hooks, which can run a project's checks. */
const WRITE_TIMEOUT_MINUTES = 10;
const WRITE_TIMEOUT = Duration.minutes(WRITE_TIMEOUT_MINUTES);
const MS_PER_SECOND = 1000;

/** The tree of an empty repository, to diff against before the first commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Fields before the path in `git status --porcelain=v2` records, by record type: changed,
 * renamed, unmerged and untracked.
 */
const FIELDS_BEFORE_PATH: ReadonlyMap<string, number> = new Map(
  ["1 2 3 4 5 6 7 8 path", "2 2 3 4 5 6 7 8 9 path", "u 2 3 4 5 6 7 8 9 10 path", "? path"].map(
    (layout) => [layout.slice(0, 1), layout.split(" ").length - 1],
  ),
);

/** Where the two status letters, staged and unstaged, sit in a record. */
const STATUS_CODE = { start: 2, end: 4 };

export class GitFailed extends Schema.TaggedError<GitFailed>()("GitFailed", {
  message: Schema.String,
}) {}

/** git's own words when it gave any, else which command failed. */
const gitFailed = (command: string, output: string) =>
  new GitFailed({ message: output.trim() === "" ? `git ${command} failed.` : output.trim() });

/** A changed file. A renamed file also names the path it had, which its commit must take too. */
export type ChangedFile = {
  readonly path: string;
  readonly previousPath: string | undefined;
  readonly status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";
};

const git = (root: string, args: readonly string[], timeout = GIT_TIMEOUT) =>
  runProgramWith("git", args, root, { timeout, streams: "all" }).pipe(
    Effect.mapError((cause) => gitFailed(args[0] ?? "", cause.message)),
  );

/** Runs git and fails with its output when it exits with an error. */
const gitOk = (root: string, args: readonly string[], timeout = GIT_TIMEOUT) =>
  git(root, args, timeout).pipe(
    Effect.flatMap(({ exitCode, output }) =>
      exitCode === 0 ? Effect.succeed(output) : Effect.fail(gitFailed(args[0] ?? "", output)),
    ),
  );

/** Every changed file, untracked ones included, from the repository root. */
export const changedFiles = (root: string) =>
  gitOk(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]).pipe(
    Effect.map(parseStatus),
  );

const parseStatus = (output: string): readonly ChangedFile[] => {
  const records = output.split("\0");
  const files: ChangedFile[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const type = record.slice(0, 1);
    const fields = FIELDS_BEFORE_PATH.get(type);
    if (fields === undefined) continue;
    const path = record.split(" ").slice(fields).join(" ");
    const code = record.slice(STATUS_CODE.start, STATUS_CODE.end);

    if (type === "2") {
      index += 1;
      files.push({ path, previousPath: records[index], status: "renamed" });
    } else files.push({ path, previousPath: undefined, status: statusOf(type, code) });
  }

  return files;
};

const statusOf = (type: string, code: string): ChangedFile["status"] => {
  if (type === "?") return "untracked";
  if (type === "u") return "conflicted";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
};

/** The commit the diffs compare with: HEAD, or the empty tree before the first commit. */
const base = (root: string) =>
  git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).pipe(
    Effect.map(({ exitCode }) => (exitCode === 0 ? "HEAD" : EMPTY_TREE)),
  );

/** The diff of every changed file, untracked ones shown as new files. */
export const diffText = Effect.fn("diffText")(function* (
  root: string,
  files: readonly ChangedFile[],
) {
  const tracked = yield* gitOk(root, ["diff", "--no-color", "--no-ext-diff", yield* base(root)]);

  const untracked = yield* Effect.forEach(
    files.filter(({ status }) => status === "untracked"),
    ({ path }) =>
      git(root, ["diff", "--no-color", "--no-index", "--", "/dev/null", path]).pipe(
        Effect.map(({ output }) => output),
      ),
  );

  return [tracked, ...untracked].join("");
});

/** The subjects of the latest `count` commits, the latest first. None before the first commit. */
export const recentSubjects = (root: string, count: number) =>
  git(root, ["log", `-${count}`, "--format=%s"]).pipe(
    Effect.map(({ exitCode, output }) =>
      exitCode === 0 ? output.split("\n").filter((line) => line !== "") : [],
    ),
  );

/** When HEAD was committed, in milliseconds since 1970. None before the first commit. */
export const headTime = (root: string) =>
  git(root, ["log", "-1", "--format=%ct"]).pipe(
    Effect.map(({ exitCode, output }) =>
      exitCode === 0 && output.trim() !== ""
        ? Option.some(Number(output.trim()) * MS_PER_SECOND)
        : Option.none<number>(),
    ),
  );

/**
 * Commits exactly `paths` with `message`, and gives the new commit's short hash. Whatever was
 * staged before is unstaged first, so the commit holds only these files.
 */
export const commitFiles = Effect.fn("commitFiles")(function* (
  root: string,
  paths: readonly string[],
  message: string,
) {
  if ((yield* base(root)) === "HEAD") yield* gitOk(root, ["reset", "--mixed", "--quiet"]);
  yield* gitOk(root, ["add", "-A", "--", ...paths]);

  if ((yield* gitOk(root, ["diff", "--cached", "--name-only"])).trim() === "") {
    const gitDir = (yield* gitOk(root, ["rev-parse", "--git-dir"])).trim();

    return yield* new GitFailed({
      message: `git add staged nothing. root: ${root}; git dir: ${gitDir}; paths: ${paths.join(", ")}`,
    });
  }

  yield* gitOk(root, ["commit", "--quiet", "-m", message], WRITE_TIMEOUT);
  return (yield* gitOk(root, ["rev-parse", "--short", "HEAD"])).trim();
});

/**
 * Where a push goes: the branch's upstream, such as `origin/main`, or `origin/<branch>` when it
 * has none yet. None when no branch is checked out.
 */
export const pushTarget = Effect.fn("pushTarget")(function* (root: string) {
  const upstream = yield* git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);

  if (upstream.exitCode === 0)
    return Option.some({ name: upstream.output.trim(), isNew: false, branch: "" });

  const branch = (yield* gitOk(root, ["branch", "--show-current"])).trim();
  if (branch === "") return Option.none();
  return Option.some({ name: `origin/${branch}`, isNew: true, branch });
});

type PushTarget = Option.Option.Value<Effect.Success<ReturnType<typeof pushTarget>>>;

/** Pushes the branch, and sets its upstream when it has none. */
export const push = (root: string, target: PushTarget) =>
  gitOk(
    root,
    target.isNew ? ["push", "--set-upstream", "origin", target.branch] : ["push"],
    WRITE_TIMEOUT,
  ).pipe(Effect.asVoid);
