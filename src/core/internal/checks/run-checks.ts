/** Finds the checks that apply to changed files, and runs them one at a time. */

import { join } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import { runCommand } from "../../../proc/Command.ts";
import type { CheckReport } from "../../../session/CheckReport.ts";
import type { Changes } from "../../../session/Entry.ts";
import type { Check } from "./checks-file.ts";
import { saveCheckReport } from "./check-report.ts";
import { OutputFiles, renderOutput } from "../output/output-files.ts";

/** A check to run, with the full paths of the changed files it matches that still exist. */
type DueCheck = { readonly check: Check; readonly files: readonly string[] };

/**
 * The checks whose globs match a changed file. With changes unknown, every check is due and gets no
 * files, so it works on the whole project. A check that takes files and has none left to take,
 * because they were deleted, is skipped.
 */
export const dueChecks = Effect.fn("dueChecks")(function* (
  checks: readonly Check[],
  root: string,
  changes: Changes,
) {
  if (changes.type === "unknown") return checks.map((check): DueCheck => ({ check, files: [] }));

  const fileSystem = yield* FileSystem.FileSystem;

  const existing = yield* Effect.filter(changes.paths, (path) =>
    fileSystem.exists(join(root, path)).pipe(Effect.orElseSucceed(() => false)),
  );

  return checks.flatMap((check): DueCheck[] => {
    const matched = changes.paths.filter((path) => matches(check, path));
    const files = existing.flatMap((path) => (matches(check, path) ? [join(root, path)] : []));
    const hasNothingToRun = matched.length === 0 || (check.takesFiles && files.length === 0);
    return hasNothingToRun ? [] : [{ check, files }];
  });
});

const matches = (check: Check, path: string) => {
  const included = check.include.length === 0 || check.include.some((glob) => glob.match(path));
  return included && !check.exclude.some((glob) => glob.match(path));
};

/** Runs each check in order. A check passes when its command exits with code 0. */
export const runChecks = Effect.fn("runChecks")(function* (due: readonly DueCheck[]) {
  if (due.length === 0) return { passed: [], failed: [], text: "", output: undefined };

  const outcomes = yield* Effect.forEach(due, ({ check, files }) => checkOutcome(check, files));

  return yield* saveCheckReport({
    passed: outcomes.flatMap(({ name, failure }) => (Option.isNone(failure) ? [name] : [])),
    failed: outcomes.flatMap(({ name, failure }) =>
      Option.toArray(Option.map(failure, (output) => ({ name, ...output }))),
    ),
  });
});

/** `failure` holds the output of a check that failed, and is none when it passed. */
const checkOutcome = (check: Check, files: readonly string[]) => {
  const outcome = (failure: Option.Option<Omit<CheckReport["failed"][number], "name">>) => ({
    name: check.name,
    failure,
  });

  return Effect.gen(function* () {
    const outputPath = yield* (yield* OutputFiles).next("check");

    const shell = {
      command: check.command,
      directory: check.directory,
      args: check.takesFiles ? files : [],
      env: check.env,
      outputPath,
    };

    const ran = yield* runCommand(shell, check.timeout);
    if (ran.exitCode === 0) return outcome(Option.none());
    const rendered = renderOutput(ran.output, "whole");
    return outcome(Option.some({ output: rendered.text, file: rendered.output }));
  }).pipe(
    Effect.catchTags({
      ShellTimedOut: (error) => {
        const rendered = renderOutput(error.output, "whole");

        return Effect.succeed(
          outcome(
            Option.some({ output: `${error.message}\n${rendered.text}`, file: rendered.output }),
          ),
        );
      },
      PlatformError: (error) => Effect.succeed(outcome(Option.some({ output: error.message }))),
      OutputUnavailable: (error) => Effect.succeed(outcome(Option.some({ output: error.message }))),
    }),
  );
};
