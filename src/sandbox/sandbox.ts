/**
 * Runs the model's `run` scripts in codemode's interpreter, and gives the file functions scripts
 * call. A script reaches the computer only through the functions it is given.
 */

import { resolve } from "node:path";
import { CodeMode, Tool, toolError } from "@opencode/codemode";
import { Duration, Effect, FileSystem, Predicate, Schema } from "effect";

/** Logs and the final value are cut to this many bytes, keeping the start. */
const MAX_OUTPUT_BYTES = 50_000;
const JSON_INDENT = 2;

export type Functions<R> = Readonly<Record<string, Tool.Tool<R>>>;

/** The text the model gets back from one script, and whether the script failed. */
export type ScriptResult = { readonly text: string; readonly isFailure: boolean };

/** The signature and description of each function, for the `run` tool's description. */
export const describeFunctions = <R>(functions: Functions<R>) =>
  CodeMode.make({ tools: functions }).catalog.map(
    (entry) => `${entry.signature}\n  ${entry.description}`,
  );

export const runScript = <R>(code: string, functions: Functions<R>, timeout: Duration.Duration) =>
  CodeMode.execute({
    code,
    tools: functions,
    limits: { timeoutMs: Duration.toMillis(timeout), maxOutputBytes: MAX_OUTPUT_BYTES },
  }).pipe(Effect.map(scriptResult));

const scriptResult = (execution: CodeMode.Result): ScriptResult => {
  const logs = execution.logs ?? [];
  const truncated = execution.truncated === true ? ["[output cut]"] : [];

  if (!execution.ok) {
    const { kind, message, location } = execution.error;
    const where = location === undefined ? "" : ` (line ${location.line})`;
    const error = `${kind}${where}: ${message}`;
    return { text: [...logs, ...truncated, error].join("\n"), isFailure: true };
  }

  const value = execution.value === null ? [] : [renderValue(execution.value)];

  const warnings = (execution.warnings ?? []).map(
    (warning) => `${warning.kind}: ${warning.message}`,
  );

  const text = [...logs, ...value, ...truncated, ...warnings].join("\n");
  return { text: text === "" ? "(no output)" : text, isFailure: false };
};

const renderValue = (value: Schema.Json) =>
  Predicate.isString(value) ? value : JSON.stringify(value, null, JSON_INDENT);

const PathInput = Schema.Struct({ path: Schema.String });
const WriteInput = Schema.Struct({ path: Schema.String, content: Schema.String });
const ReplaceInput = Schema.Struct({ path: Schema.String, old: Schema.String, new: Schema.String });

/** `read`, `write` and `replace`. Relative paths start at `directory`. */
export const fileFunctions = (directory: string) => {
  const at = (path: string) => resolve(directory, path);

  const failed = (path: string) => (error: { readonly message: string }) =>
    toolError(`${path}: ${error.message}`);

  return {
    read: Tool.make({
      description: "Reads a text file.",
      input: PathInput,
      output: Schema.String,
      execute: ({ path }) => readFile(at(path)).pipe(Effect.mapError(failed(path))),
    }),
    write: Tool.make({
      description: "Writes a text file, and makes its folders if they do not exist.",
      input: WriteInput,
      execute: ({ path, content }) =>
        writeFile(at(path), content).pipe(Effect.mapError(failed(path))),
    }),
    replace: Tool.make({
      description:
        "Replaces the one place in a file where `old` appears with `new`. Fails if `old` appears zero times or more than once.",
      input: ReplaceInput,
      execute: (input) =>
        replaceOnce(at(input.path), input).pipe(Effect.mapError(failed(input.path))),
    }),
  };
};

/** `replace` changes only text that appears once, so it never edits the wrong place. */
class TextNotUnique extends Schema.TaggedError<TextNotUnique>()("TextNotUnique", {
  count: Schema.Int,
}) {
  override get message() {
    return `the text to replace appears ${this.count} times, not once`;
  }
}

const readFile = Effect.fn("readFile")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(path);
});

const writeFile = Effect.fn("writeFile")(function* (path: string, content: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(resolve(path, ".."), { recursive: true });
  yield* fileSystem.writeFileString(path, content);
});

const replaceOnce = Effect.fn("replaceOnce")(function* (
  path: string,
  edit: typeof ReplaceInput.Type,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(path);
  const count = text.split(edit.old).length - 1;

  if (count !== 1) return yield* new TextNotUnique({ count });

  yield* fileSystem.writeFileString(
    path,
    text.replace(edit.old, () => edit.new),
  );
});
