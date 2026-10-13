/**
 * The model's one tool, `run`: the functions a script can call, the tool's description, and the
 * text one call returns.
 */

import { searchSignature, Tool as ScriptFunction, toolError } from "@opencode/codemode";
import { Duration, Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { runCommand } from "../../../proc/Command.ts";
import {
  describeFunctions,
  fileFunctions,
  type Functions,
  runScript,
  type ScriptResult,
  type Touched,
} from "../../../sandbox/Sandbox.ts";
import { SKILLS_GROUP } from "../skills/skills.ts";

export type Timeouts = { readonly run: Duration.Duration; readonly shell: Duration.Duration };

const Seconds = Schema.Finite.check(Schema.isGreaterThan(0));

const RunParameters = Schema.Struct({
  code: Schema.String,
  timeoutSeconds: Schema.optional(Seconds),
});

const ShellInput = Schema.Struct({
  command: Schema.String,
  timeoutSeconds: Schema.optional(Seconds),
});

const ShellOutput = Schema.Struct({ exitCode: Schema.Number, output: Schema.String });

const sh = (directory: string, timeout: Duration.Duration) =>
  ScriptFunction.make({
    description: `Runs a shell command in the session directory with \`sh -c\`. Returns the exit code and the output, stdout and stderr together. Throws after timeoutSeconds, default ${Duration.toSeconds(timeout)}, with the output so far, and stops the command and everything it started.`,
    input: ShellInput,
    output: ShellOutput,
    execute: (input) =>
      runCommand(input.command, directory, secondsOr(input.timeoutSeconds, timeout)).pipe(
        Effect.catchTags({
          CommandTimedOut: (error) => Effect.fail(toolError(`${error.message}\n${error.output}`)),
          PlatformError: (error) => Effect.fail(toolError(error.message)),
        }),
      ),
  });

/** The functions a `run` script can call, working in `directory`. Skills are added beside them. */
export const scriptFunctions = (directory: string, timeouts: Timeouts, touched: Touched) => ({
  sh: sh(directory, timeouts.shell),
  ...fileFunctions(directory, touched),
});

export const runToolkit = <R>(functions: Functions<R>, timeouts: Timeouts) =>
  Toolkit.make(
    Tool.make("run", {
      description: runDescription(describeFunctions(withoutSkills(functions)), timeouts),
      parameters: RunParameters,
      success: Schema.String,
    }),
  );

/**
 * The skills are left out of the description, so adding a skill never changes the tool and the
 * cached start of each request stays the same.
 */
const withoutSkills = <R>(functions: Functions<R>): Functions<R> =>
  Object.fromEntries(Object.entries(functions).filter(([name]) => name !== SKILLS_GROUP));

const runDescription = (functions: readonly string[], timeouts: Timeouts) =>
  [
    "Runs a JavaScript program. The program reaches the computer only through these functions, called as `await tools.<name>(input)`:",
    "",
    ...functions,
    "",
    `Skills hold instructions for particular tasks, as functions in tools.${SKILLS_GROUP}. Find them with the built-in search function, such as search({ namespace: "${SKILLS_GROUP}", query: "pdf forms" }):`,
    searchSignature,
    "",
    "Only what the program prints with console.log and the value it returns come back. A function that fails throws.",
    `The whole program stops after timeoutSeconds, default ${Duration.toSeconds(timeouts.run)}. This always wins over a shell command's own timeout.`,
  ].join("\n");

/** Runs one `run` call. Parameters the model got wrong come back as a failed result. */
export const runCall = <R>(params: Schema.Json, functions: Functions<R>, timeouts: Timeouts) =>
  Schema.decodeUnknownEffect(RunParameters)(params).pipe(
    Effect.matchEffect({
      onFailure: (error): Effect.Effect<ScriptResult, never, R> =>
        Effect.succeed({ text: `The run parameters are wrong: ${error.message}`, isFailure: true }),
      onSuccess: (input) =>
        runScript(input.code, functions, secondsOr(input.timeoutSeconds, timeouts.run)),
    }),
  );

const secondsOr = (seconds: number | undefined, fallback: Duration.Duration) =>
  seconds === undefined ? fallback : Duration.seconds(seconds);
