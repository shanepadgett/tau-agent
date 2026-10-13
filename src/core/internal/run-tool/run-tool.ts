/**
 * The model's one tool, `run`: the functions a script can call, the tool's description, and the
 * text one call returns.
 */

import { searchSignature, Tool as ScriptFunction, toolError } from "@opencode/codemode";
import { Duration, Effect, Option, Result, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { runCommand } from "../../../proc/Command.ts";
import {
  describeFunctions,
  Edit,
  fileFunctions,
  type Functions,
  replaceUnique,
  runScript,
  type ScriptResult,
  type Touched,
} from "../../../sandbox/Sandbox.ts";
import type { WriteQueue } from "../../../sandbox/WriteQueue.ts";
import type { Entry } from "../../../session/Entry.ts";
import { findScript } from "../loop/tool-history.ts";
import { SKILLS_GROUP } from "../skills/skills.ts";

export type Timeouts = { readonly run: Duration.Duration; readonly shell: Duration.Duration };

const Seconds = Schema.Finite.check(Schema.isGreaterThan(0));

/**
 * A call sends `code`, or `scriptId` and `edits` to fix an earlier script. They are optional fields
 * of one object, not a union, because providers require the root of a tool's schema to be an object.
 */
const RunParameters = Schema.Struct({
  code: Schema.optional(Schema.String),
  scriptId: Schema.optional(Schema.Int),
  edits: Schema.optional(Schema.NonEmptyArray(Edit)),
  timeoutSeconds: Schema.optional(Seconds),
});

/** `script` is the code that ran; a call that ran nothing has none. */
export type RunResult = ScriptResult & { readonly script: string | undefined };

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
export const scriptFunctions = (
  directory: string,
  timeouts: Timeouts,
  touched: Touched,
  queue: WriteQueue,
) => ({
  sh: sh(directory, timeouts.shell),
  ...fileFunctions(directory, touched, queue),
});

/**
 * Effect checks a tool's parameters while it reads the reply, and a call that fails that check ends
 * the run. So the tool gives Effect only the JSON schema, and `runCall` checks the parameters,
 * where a wrong call becomes a failed result the model can fix. Strict mode is off because OpenAI's
 * strict schemas make every optional field required, and models then fill in fields they should
 * leave out.
 */
const RUN_PARAMETERS_JSON_SCHEMA = Tool.getJsonSchemaFromSchema(RunParameters);

export const runToolkit = <R>(functions: Functions<R>, timeouts: Timeouts) =>
  Toolkit.make(
    Tool.dynamic("run", {
      description: runDescription(describeFunctions(withoutSkills(functions)), timeouts),
      parameters: RUN_PARAMETERS_JSON_SCHEMA,
      success: Schema.String,
    }).annotate(Tool.Strict, false),
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
    "",
    "When a program fails, its result ends with a Script ID. To fix it, send scriptId and edits instead of code. Each edit changes the one place in that program where `old` appears to `new`, in order. If an `old` appears zero times or more than once, nothing runs.",
  ].join("\n");

/**
 * Runs one `run` call: its code, or an earlier script with edits. Parameters the model got wrong
 * and edits that do not apply come back as a failed result.
 */
export const runCall = <R>(
  params: Schema.Json,
  entries: readonly Entry[],
  functions: Functions<R>,
  timeouts: Timeouts,
): Effect.Effect<RunResult, never, R> => {
  const parsed = Schema.decodeUnknownResult(RunParameters)(params).pipe(
    Result.mapError((error) => `The run parameters are wrong: ${error.message}`),
    Result.flatMap((input) =>
      scriptToRun(input, entries).pipe(
        Result.map((script) => ({ script, timeoutSeconds: input.timeoutSeconds })),
      ),
    ),
  );

  if (Result.isFailure(parsed))
    return Effect.succeed({ text: parsed.failure, isFailure: true, script: undefined });

  const { script, timeoutSeconds } = parsed.success;

  return runScript(script, functions, secondsOr(timeoutSeconds, timeouts.run)).pipe(
    Effect.map((ran) => ({ ...ran, script })),
  );
};

const scriptToRun = (
  input: typeof RunParameters.Type,
  entries: readonly Entry[],
): Result.Result<string, string> => {
  const { code, scriptId, edits } = input;
  const sendsCodeOnly = code !== undefined && scriptId === undefined && edits === undefined;
  if (sendsCodeOnly) return Result.succeed(code);

  const sendsEditsOnly = code === undefined && scriptId !== undefined && edits !== undefined;
  if (sendsEditsOnly) return editedScript(entries, scriptId, edits);

  return Result.fail("Send code, or scriptId and edits, not both.");
};

/** All edits apply, or none do: a failed edit leaves the earlier script as it was. */
const editedScript = (
  entries: readonly Entry[],
  scriptId: number,
  edits: readonly (typeof Edit.Type)[],
): Result.Result<string, string> => {
  const earlier = findScript(entries, scriptId);

  if (Option.isNone(earlier))
    return Result.fail(`There is no script ${scriptId}. Send the whole program as code.`);

  let script = earlier.value;

  for (const [index, edit] of edits.entries()) {
    const edited = replaceUnique(script, edit);

    if (Result.isFailure(edited))
      return Result.fail(
        `Edit ${index + 1} of script ${scriptId}: ${edited.failure.message}. Nothing ran; fix the edits and send them again.`,
      );

    script = edited.success;
  }

  return Result.succeed(script);
};

const secondsOr = (seconds: number | undefined, fallback: Duration.Duration) =>
  seconds === undefined ? fallback : Duration.seconds(seconds);
