/**
 * The `run` tool: the functions a script can call, the tool's description, and what one call
 * returns. With project checks, a call also finds the files its script changed and runs the fixers.
 */

import { searchSignature, Tool as ScriptFunction, toolError } from "@opencode/codemode";
import { resolve } from "node:path";
import { Duration, Effect, FileSystem, Option, Ref, Result, Schema } from "effect";
import { Tool } from "effect/ai";
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
import type { Entry, ImageRef } from "../../../session/Entry.ts";
import { saveImageBytes } from "../images/image-files.ts";
import { withChanges } from "../checks/changes.ts";
import type { ProjectChecks } from "../checks/checks-file.ts";
import { findScript, type ToolCall } from "../loop/tool-history.ts";
import { SKILLS_GROUP } from "../skills/skills.ts";
import type { ModelTool, Platform } from "../tools/model-tool.ts";
import { OutputFiles, renderOutput, saveOutput } from "../output/output-files.ts";

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
type RunResult = ScriptResult & { readonly script: string | undefined };

const ShellInput = Schema.Struct({
  command: Schema.String,
  timeoutSeconds: Schema.optional(Seconds),
});

const ShellOutput = Schema.Struct({ exitCode: Schema.Number, output: Schema.String });

const sh = (directory: string, timeout: Duration.Duration) =>
  ScriptFunction.make({
    description: `Runs a shell command in the session directory with \`sh -c\`. Returns the exit code and the output, stdout and stderr together. Large output keeps the start and end, with a path to the whole output that you can search with sh. Throws after timeoutSeconds, default ${Duration.toSeconds(timeout)}, with the output so far, and stops the command and everything it started.`,
    input: ShellInput,
    output: ShellOutput,
    execute: (input) =>
      Effect.gen(function* () {
        const outputPath = yield* (yield* OutputFiles).next("sh");

        const ran = yield* runCommand(
          { command: input.command, directory, args: [], env: {}, outputPath },
          secondsOr(input.timeoutSeconds, timeout),
        );

        return { exitCode: ran.exitCode, output: renderOutput(ran.output, "whole").text };
      }).pipe(
        Effect.catchTags({
          ShellTimedOut: (error) =>
            Effect.fail(toolError(`${error.message}\n${renderOutput(error.output, "whole").text}`)),
          PlatformError: (error) => Effect.fail(toolError(error.message)),
          OutputUnavailable: (error) => Effect.fail(toolError(error.message)),
        }),
      ),
  });

const ImageInput = Schema.Struct({ path: Schema.String });

/** Adds a saved picture to the ones the model sees after the call. */
export type Attach = (image: ImageRef) => Effect.Effect<void>;

const image = (directory: string, attach: Attach) =>
  ScriptFunction.make({
    description:
      "Shows a picture file (PNG, JPEG, WebP, GIF or BMP) to the model, shrunk to fit. The model sees the picture after the script ends. Returns a note that the picture is attached.",
    input: ImageInput,
    output: Schema.String,
    execute: ({ path }) =>
      Effect.gen(function* () {
        const bytes = yield* (yield* FileSystem.FileSystem).readFile(resolve(directory, path));
        const saved = yield* saveImageBytes(bytes);
        yield* attach(saved);
        return `${path} is attached as a ${saved.mediaType} picture.`;
      }).pipe(Effect.mapError((error) => toolError(`${path}: ${error.message}`))),
  });

/** The functions a `run` script can call, working in `directory`. Skills are added beside them. */
export const scriptFunctions = (
  directory: string,
  timeouts: Timeouts,
  hooks: { readonly touched: Touched; readonly attach: Attach; readonly queue: WriteQueue },
) => ({
  sh: sh(directory, timeouts.shell),
  image: image(directory, hooks.attach),
  ...fileFunctions(directory, hooks.touched, hooks.queue),
});

/**
 * Effect checks a tool's parameters while it reads the reply, and a call that fails that check ends
 * the run. So the tool gives Effect only the JSON schema, and `runCall` checks the parameters,
 * where a wrong call becomes a failed result the model can fix. Strict mode is off because OpenAI's
 * strict schemas make every optional field required, and models then fill in fields they should
 * leave out.
 */
const RUN_PARAMETERS_JSON_SCHEMA = Tool.getJsonSchemaFromSchema(RunParameters);

/**
 * The `run` tool. `functions` gives the functions of one script, which report each file they touch.
 * With `checks`, each call also saves the files its script changed, after the fixers ran.
 */
export const runTool = <R>(
  functions: (touched: Touched, attach: Attach) => Functions<R>,
  timeouts: Timeouts,
  checks: Option.Option<ProjectChecks>,
): ModelTool<R | Platform> => ({
  definition: Tool.dynamic("run", {
    description: runDescription(
      describeFunctions(
        withoutSkills(
          functions(
            () => Effect.void,
            () => Effect.void,
          ),
        ),
      ),
      timeouts,
    ),
    parameters: RUN_PARAMETERS_JSON_SCHEMA,
    success: Schema.String,
  }).annotate(Tool.Strict, false),

  call: Effect.fn("runTool")(function* (call: ToolCall, entries: readonly Entry[]) {
    const touched = yield* Ref.make<ReadonlySet<string>>(new Set());
    const touch = (path: string) => Ref.update(touched, (paths) => new Set(paths).add(path));
    const pictures = yield* Ref.make<readonly ImageRef[]>([]);
    const attach = (picture: ImageRef) => Ref.update(pictures, (all) => [...all, picture]);
    const script = runCall(call.params, entries, functions(touch, attach), timeouts);

    const [ran, changes] = yield* Option.match(checks, {
      onNone: () => script.pipe(Effect.map((outcome) => [outcome, undefined] as const)),
      onSome: (project) => withChanges(project, script),
    });

    const files = [...(yield* Ref.get(touched))];
    const extent = ran.truncation === "interpreter" ? "retained" : "whole";

    const saved = yield* saveOutput([ran.text], "run", extent).pipe(
      Effect.map((output) => ({ ...output, isFailure: ran.isFailure })),
      Effect.catchTag("OutputUnavailable", (error) =>
        Effect.succeed({
          text: error.message,
          output: undefined,
          isFailure: true,
        }),
      ),
    );

    const details = {
      tool: "run" as const,
      script: ran.script,
      files,
      changes,
      output: saved.output,
    };

    return {
      text: saved.text,
      isFailure: saved.isFailure,
      details,
      images: yield* Ref.get(pictures),
    };
  }),
});

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
    "Large results keep the start and end, with a path to the saved output. Search that file with sh, or print less. The interpreter bounds console capture and formatting while the script runs and limits returned output to 10 MB. Discarded script output cannot be recovered.",
    `The whole program stops after timeoutSeconds, default ${Duration.toSeconds(timeouts.run)}. This always wins over a shell command's own timeout.`,
    "",
    "When a program fails, its result ends with a Script ID. To fix it, send scriptId and edits instead of code. Each edit changes the one place in that program where `old` appears to `new`, in order. If an `old` appears zero times or more than once, nothing runs.",
  ].join("\n");

/**
 * Runs one `run` call: its code, or an earlier script with edits. Parameters the model got wrong
 * and edits that do not apply come back as a failed result.
 */
const runCall = <R>(
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
    return Effect.succeed({
      text: parsed.failure,
      isFailure: true,
      script: undefined,
      truncation: "none",
    });

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
