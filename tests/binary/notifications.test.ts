import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Schema } from "effect";

// Native compilation belongs to the before-commit tier.
const BUILD_AND_RUN_MILLIS = 60_000;

const encodeImport = Schema.encodeSync(Schema.fromJsonString(Schema.String));

test(
  "a standalone binary decodes its embedded notification sound outside the repository",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const folder = yield* fs.makeTempDirectoryScoped();

      const entry = folder + "/notification.ts";

      const binary = folder + "/notification";

      const notifications = fileURLToPath(import.meta.resolve("../../src/tui/Notifications.ts"));

      const effect = fileURLToPath(import.meta.resolve("effect"));

      const source = [
        "import { NotificationAudio } from " + encodeImport(notifications) + ";",
        "import { Effect } from " + encodeImport(effect) + ";",
        "await Effect.runPromise(Effect.gen(function* () {",
        "  const open = yield* NotificationAudio;",
        "  yield* open;",
        "}).pipe(Effect.scoped));",
        'process.stdout.write("decoded embedded WAV");',
      ].join("\n");

      yield* fs.writeFileString(entry, source);

      const built = yield* Effect.promise(() =>
        Bun.build({
          entrypoints: [entry],
          target: "bun",
          compile: { outfile: binary, autoloadBunfig: false },
          throw: false,
        }),
      );

      expect(built.logs.map((log) => log.message)).toEqual([]);

      expect(built.success).toBe(true);

      yield* fs.remove(entry);

      const child = Bun.spawn([binary], { cwd: folder, stdout: "pipe", stderr: "pipe" });

      const [output, errors, exitCode] = yield* Effect.promise(() =>
        Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]),
      );

      expect(exitCode).toBe(0);

      expect(errors).toBe("");

      expect(output).toContain("decoded embedded WAV");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise),
  BUILD_AND_RUN_MILLIS,
);
