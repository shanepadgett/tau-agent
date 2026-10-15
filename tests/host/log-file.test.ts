import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Scope } from "effect";
import { join } from "node:path";
import { TauHome } from "../../src/database/TauHome.ts";
import { logFileLayer } from "../../src/host/LogFile.ts";
import { Settings } from "../../src/host/Settings.ts";
import { ProjectDirectory } from "../../src/host/ProjectDirectory.ts";

const DAY_MILLIS = 24 * 60 * 60 * 1000;

/** Runs `effect` with the log file layer in a new Tau home, and gives the home's logs folder. */
const withLogFile = <A>(
  effect: Effect.Effect<A>,
  prepare: (logs: string) => Effect.Effect<void, unknown, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const home = yield* fileSystem.makeTempDirectoryScoped();

    const logs = join(home, "logs");
    yield* prepare(logs);

    const layer = logFileLayer.pipe(
      Layer.provide(
        Settings.layer.pipe(Layer.provide(Layer.succeed(ProjectDirectory, { directory: home }))),
      ),
      Layer.provide(TauHome.at(home)),
    );

    yield* Effect.scoped(Effect.provide(effect, layer));
    return logs;
  });

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)));

describe("the log file", () => {
  test("keeps warnings with their annotations as JSON lines, and drops what is below Warn", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;

        const logged = Effect.logWarning("Disk full").pipe(
          Effect.andThen(Effect.logInfo("Started")),
          Effect.annotateLogs({ session: "s1" }),
        );

        const logs = yield* withLogFile(logged, () => Effect.void);

        const [name] = yield* fileSystem.readDirectory(logs);
        expect(name).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d+\.jsonl$/);

        const text = yield* fileSystem.readFileString(join(logs, name ?? ""));

        const lines = text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));

        expect(lines).toEqual([
          expect.objectContaining({ message: "Disk full", annotations: { session: "s1" } }),
        ]);
      }),
    ));

  test("removes log files older than 14 days and keeps newer ones", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;

        const logs = yield* withLogFile(Effect.void, (folder) =>
          Effect.gen(function* () {
            yield* fileSystem.makeDirectory(folder, { recursive: true });
            yield* fileSystem.writeFileString(join(folder, "old.jsonl"), "");

            yield* fileSystem.writeFileString(join(folder, "recent.jsonl"), "");
            const old = new Date(Date.now() - 15 * DAY_MILLIS);

            yield* fileSystem.utimes(join(folder, "old.jsonl"), old, old);
          }),
        );

        const names = yield* fileSystem.readDirectory(logs);

        expect(names).toContain("recent.jsonl");
        expect(names).not.toContain("old.jsonl");
      }),
    ));
});
