/**
 * Reads a project's checks from `.tau/checks.json` at the repository root, or in the session
 * directory outside git. Read once per run, so a change applies from the next prompt.
 */

import { join, resolve } from "node:path";
import { Duration, Effect, FileSystem, Option, Schema } from "effect";

const CHECKS_FILE = join(".tau", "checks.json");
const DEFAULT_TIMEOUT_SECONDS = 120;

/** In a command, the files that changed. It becomes `"$@"`, and the paths are its arguments. */
const FILES_PLACEHOLDER = "{files}";

const CheckEntry = Schema.Struct({
  name: Schema.NonEmptyString,
  command: Schema.NonEmptyString,
  details: Schema.optional(Schema.String),
  include: Schema.optional(Schema.Array(Schema.String)),
  exclude: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  timeoutSeconds: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
});

type CheckEntry = typeof CheckEntry.Type;

/** `commit` runs only in `/commit`, after `check`. */
const ChecksFile = Schema.Struct({
  fix: Schema.optional(Schema.Array(CheckEntry)),
  check: Schema.optional(Schema.Array(CheckEntry)),
  commit: Schema.optional(Schema.Array(CheckEntry)),
});

/**
 * One command. `include` and `exclude` match paths from the repository root; with no `include`,
 * every path matches. `takesFiles` is true when the command gets the matching files as arguments.
 */
export type Check = {
  readonly name: string;
  readonly details: string | undefined;
  readonly command: string;
  readonly takesFiles: boolean;
  readonly include: readonly Bun.Glob[];
  readonly exclude: readonly Bun.Glob[];
  readonly directory: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeout: Duration.Duration;
};

/**
 * `detection` is `git` when Tau can see which files a script changed, and `none` outside a
 * repository.
 */
export type ProjectChecks = {
  readonly root: string;
  readonly detection: "git" | "none";
  readonly fix: readonly Check[];
  readonly check: readonly Check[];
  readonly commit: readonly Check[];
};

class ChecksFileInvalid extends Schema.TaggedError<ChecksFileInvalid>()("ChecksFileInvalid", {
  path: Schema.String,
  problem: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `${this.path} ${this.problem}. Fix the file, or remove it to run without checks.`;
  }
}

/** None when the project has no checks file, or the file lists no commands. */
export const readProjectChecks = Effect.fn("readProjectChecks")(function* (
  directory: string,
  repositoryRoot: Option.Option<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = Option.getOrElse(repositoryRoot, () => directory);
  const path = join(root, CHECKS_FILE);

  if (!(yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false))))
    return Option.none<ProjectChecks>();

  const text = yield* fileSystem
    .readFileString(path)
    .pipe(
      Effect.mapError((cause) => new ChecksFileInvalid({ path, problem: "cannot be read", cause })),
    );

  const parsed = yield* Effect.try({
    try: () => Bun.JSONC.parse(text),
    catch: (cause) => new ChecksFileInvalid({ path, problem: "is not valid JSON", cause }),
  });

  const file = yield* Schema.decodeUnknownEffect(ChecksFile)(parsed).pipe(
    Effect.mapError(
      (cause) =>
        new ChecksFileInvalid({ path, problem: `has a wrong value: ${cause.message}`, cause }),
    ),
  );

  const checks: ProjectChecks = {
    root,
    detection: Option.isSome(repositoryRoot) ? "git" : "none",
    fix: (file.fix ?? []).map((entry) => toCheck(root, entry)),
    check: (file.check ?? []).map((entry) => toCheck(root, entry)),
    commit: (file.commit ?? []).map((entry) => toCheck(root, entry)),
  };

  const isEmpty = [checks.fix, checks.check, checks.commit].every((list) => list.length === 0);
  return isEmpty ? Option.none<ProjectChecks>() : Option.some(checks);
});

const toCheck = (root: string, entry: CheckEntry): Check => ({
  name: entry.name,
  details: entry.details,
  command: entry.command.replaceAll(FILES_PLACEHOLDER, '"$@"'),
  takesFiles: entry.command.includes(FILES_PLACEHOLDER),
  include: (entry.include ?? []).map((pattern) => new Bun.Glob(pattern)),
  exclude: (entry.exclude ?? []).map((pattern) => new Bun.Glob(pattern)),
  directory: resolve(root, entry.cwd ?? "."),
  env: entry.env ?? {},
  timeout: Duration.seconds(entry.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS),
});
