/** The `process` functions of a `run` script, for commands that keep running after the script ends. */

import { Namespace, Tool as ScriptFunction, toolError } from "@opencode/codemode";
import { Effect, Schema } from "effect";
import type { ProcessSessions, ProcessSummary, WaitResult } from "../../../proc/ProcessSessions.ts";

export const PROCESS_GROUP = "process";

const START_WAIT_SECONDS = 1;
const MIN_START_WAIT_SECONDS = 0.25;
const MAX_START_WAIT_SECONDS = 30;
const QUIET_SECONDS = 30;

const Seconds = Schema.Finite.check(Schema.isGreaterThan(0));
const Id = Schema.Struct({ id: Schema.String });

const ProcessView = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  pty: Schema.Boolean,
  status: Schema.Literals(["running", "exited", "killed"]),
  exitCode: Schema.optional(Schema.Int),
});

const WaitView = Schema.Struct({
  reason: Schema.Literals(["exited", "killed", "matched", "quiet", "deadline"]),
  exitCode: Schema.optional(Schema.Int),
  output: Schema.String,
  tail: Schema.optional(Schema.String),
});

const StartInput = Schema.Struct({
  command: Schema.String,
  pty: Schema.optional(Schema.Boolean),
  waitSeconds: Schema.optional(
    Schema.Finite.check(
      Schema.isBetween({ minimum: MIN_START_WAIT_SECONDS, maximum: MAX_START_WAIT_SECONDS }),
    ),
  ),
});

const WaitInput = Schema.Struct({
  id: Schema.String,
  pattern: Schema.optional(Schema.String),
  quietSeconds: Schema.optional(Seconds),
  deadlineSeconds: Schema.optional(Seconds),
});

const processView = (summary: ProcessSummary) => ({
  id: summary.id,
  command: summary.command,
  pty: summary.pty,
  status: summary.state.type,
  exitCode: summary.state.type === "exited" ? summary.state.exitCode : undefined,
});

const waitView = (waited: WaitResult) => ({
  reason: waited.reason,
  exitCode: waited.reason === "exited" ? waited.exitCode : undefined,
  output: waited.output,
  tail: waited.reason === "exited" || waited.reason === "killed" ? undefined : waited.tail,
});

const failed = (error: { readonly message: string }) => toolError(error.message);

const startFunction = (sessions: ProcessSessions, directory: string) =>
  ScriptFunction.make({
    description: `Starts a shell command in the session directory and leaves it running. Waits up to waitSeconds (default ${START_WAIT_SECONDS}, from ${MIN_START_WAIT_SECONDS} to ${MAX_START_WAIT_SECONDS}) for it to exit, then returns its id, the output so far and, if it exited, its exit code. The command keeps running after your program ends, until you kill it, it exits, or the session closes. Set pty for a program that needs a terminal, such as a REPL or a prompt.`,
    input: StartInput,
    output: Schema.Struct({ id: Schema.String, ...WaitView.fields }),
    execute: (input) =>
      sessions
        .start({
          command: input.command,
          directory,
          pty: input.pty ?? false,
          waitSeconds: input.waitSeconds ?? START_WAIT_SECONDS,
        })
        .pipe(
          Effect.map((started) => ({ id: started.process.id, ...waitView(started.waited) })),
          Effect.mapError(failed),
        ),
  });

const waitFunction = (sessions: ProcessSessions) =>
  ScriptFunction.make({
    description: `Waits for a process session to exit, for an output line to match pattern (a regular expression), for quietSeconds (default ${QUIET_SECONDS}) without new output, or for deadlineSeconds, whichever comes first. Returns why it stopped and the output since your last read; when no new output arrived, tail holds the last lines. The program's own timeout always wins over deadlineSeconds. Then decide: keep waiting, write to it, or kill it.`,
    input: WaitInput,
    output: WaitView,
    execute: (input) =>
      Effect.gen(function* () {
        const pattern = yield* compilePattern(input.pattern);

        const waited = yield* sessions.wait(input.id, {
          pattern,
          quietSeconds: input.quietSeconds ?? QUIET_SECONDS,
          deadlineSeconds: input.deadlineSeconds ?? Number.POSITIVE_INFINITY,
        });

        return waitView(waited);
      }).pipe(Effect.mapError(failed)),
  });

/** The `process` group, for the commands of one Tau session. Commands start in `directory`. */
export const processFunctions = (sessions: ProcessSessions, directory: string) =>
  Namespace.make({
    description:
      "Commands that keep running after the program ends, such as a dev server, a watcher or a REPL",
    tools: {
      start: startFunction(sessions, directory),
      list: ScriptFunction.make({
        description: "Lists the process sessions with their ids and states.",
        input: Schema.Struct({}),
        output: Schema.Array(ProcessView),
        execute: () => sessions.list.pipe(Effect.map((summaries) => summaries.map(processView))),
      }),
      read: ScriptFunction.make({
        description:
          "Reads the output a process session printed since your last read, and its state.",
        input: Id,
        output: Schema.Struct({ process: ProcessView, output: Schema.String }),
        execute: ({ id }) =>
          sessions.read(id).pipe(
            Effect.map((read) => ({ process: processView(read.process), output: read.output })),
            Effect.mapError(failed),
          ),
      }),
      readAll: ScriptFunction.make({
        description:
          "Reads all the output a process session kept, read before or not. Very long output keeps its start and end.",
        input: Id,
        output: Schema.String,
        execute: ({ id }) => sessions.readAll(id).pipe(Effect.mapError(failed)),
      }),
      write: ScriptFunction.make({
        description:
          "Writes text to the input of a running process session. End a line with \\n to send it.",
        input: Schema.Struct({ id: Schema.String, text: Schema.String }),
        execute: ({ id, text }) => sessions.write(id, text).pipe(Effect.mapError(failed)),
      }),
      wait: waitFunction(sessions),
      kill: ScriptFunction.make({
        description: "Kills a process session and everything it started.",
        input: Id,
        output: ProcessView,
        execute: ({ id }) =>
          sessions.kill(id).pipe(Effect.map(processView), Effect.mapError(failed)),
      }),
    },
  });

const compilePattern = (source: string | undefined) =>
  Effect.try({
    try: () => (source === undefined ? undefined : new RegExp(source)),
    catch: () => ({ message: `The pattern ${source} is not a valid regular expression.` }),
  });
