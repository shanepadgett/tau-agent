import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Duration, Effect, FileSystem } from "effect";
import { runCommand, runProgram } from "../../src/proc/Command.ts";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "../../src/proc/Output.ts";

describe("shell output", () => {
  test("returns a nonzero exit and combined stdout and stderr", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();

          const ran = yield* runCommand(
            {
              command: "printf out; printf err >&2; exit 7",
              directory,
              args: [],
              env: {},
              outputPath: `${directory}/output`,
            },
            Duration.seconds(5),
          );

          expect(ran).toMatchObject({ exitCode: 7 });
          expect(ran.output.type).toBe("whole");
          if (ran.output.type !== "whole") throw new Error("Expected whole output");
          expect(ran.output.text).toContain("out");
          expect(ran.output.text).toContain("err");
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    ));

  test("a spill failure stops the command without claiming a complete log", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const directory = yield* fileSystem.makeTempDirectoryScoped();

          const failed = yield* Effect.result(
            runCommand(
              {
                command: "echo $$ > pid; seq 1 3000; sleep 5",
                directory,
                args: [],
                env: {},
                outputPath: `${directory}/missing/output`,
              },
              Duration.seconds(5),
            ),
          );

          expect(failed._tag).toBe("Failure");
          if (failed._tag !== "Failure") throw new Error("Expected spill failure");
          expect(failed.failure._tag).toBe("PlatformError");
          expect(yield* fileSystem.exists(`${directory}/missing/output`)).toBe(false);
          const pid = (yield* fileSystem.readFileString(`${directory}/pid`)).trim();
          const alive = yield* runProgram("kill", ["-0", pid], directory, Duration.seconds(5));
          expect(alive.exitCode).not.toBe(0);
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    ));

  test("yes times out, closes its spill file and kills its process group", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const directory = yield* fileSystem.makeTempDirectoryScoped();
          const outputPath = `${directory}/output`;

          const timedOut = yield* runCommand(
            { command: "echo $$ > pid; yes", directory, args: [], env: {}, outputPath },
            Duration.millis(200),
          ).pipe(
            Effect.map(() => undefined),
            Effect.catchTag("ShellTimedOut", (error) => Effect.succeed(error)),
          );

          if (timedOut === undefined) throw new Error("Expected timeout");
          expect(timedOut.output.type).toBe("cut");
          if (timedOut.output.type !== "cut") throw new Error("Expected cut output");

          expect(timedOut.output.start.split("\n").length).toBeLessThanOrEqual(
            MAX_OUTPUT_LINES / 2 + 1,
          );

          expect(timedOut.output.bytes).toBeGreaterThan(MAX_OUTPUT_BYTES);
          const bytes = yield* fileSystem.readFile(outputPath);
          expect(bytes.length).toBe(timedOut.output.bytes);
          const pid = (yield* fileSystem.readFileString(`${directory}/pid`)).trim();
          const alive = yield* runProgram("kill", ["-0", pid], directory, Duration.seconds(5));
          expect(alive.exitCode).not.toBe(0);
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    ));
});
