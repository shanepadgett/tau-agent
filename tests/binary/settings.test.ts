import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Duration, Effect, FileSystem } from "effect";
import { runProgramWith } from "../../src/proc/Command.ts";
import { compileTau } from "../support/compile-tau.ts";
import { shell } from "../support/git.ts";

test(
  "compiled Tau finds project settings at the Git root and outside Git",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const binary = yield* compileTau(yield* fs.makeTempDirectoryScoped());

      for (const repository of [true, false]) {
        const root = yield* fs.makeTempDirectoryScoped();
        if (repository) yield* shell(root, "git init -q");
        yield* fs.makeDirectory(root + "/.tau");
        const settingsPath = root + "/.tau/settings.json";
        yield* fs.writeFileString(settingsPath, '{"commit":{"avoidBreakingChanges":"invalid"}}');
        const directory = repository ? root + "/nested" : root;

        if (repository) {
          yield* fs.makeDirectory(directory + "/.tau", { recursive: true });
          yield* fs.writeFileString(directory + "/.tau/settings.json", "{}");
        }

        const result = yield* runProgramWith(
          "env",
          ["HOME=" + home, binary, "-p", "test"],
          directory,
          { timeout: Duration.seconds(15), streams: "all" },
        );

        expect(result.output).toContain(settingsPath);
        expect(result.output).toContain("avoidBreakingChanges");
      }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise),
  60000,
);
