import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Context, Effect, Exit, FileSystem, Layer } from "effect";
import { TauHome } from "../../src/database/TauHome.ts";
import { Settings } from "../../src/host/Settings.ts";
import { CommitSettings } from "../../src/core/Commits.ts";
import { ContextSettings } from "../../src/core/ContextSettings.ts";
import { ProviderId, ProviderTable } from "../../src/ai/Providers.ts";
import { ProjectDirectory } from "../../src/host/ProjectDirectory.ts";

const readNotifications = (contents: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const home = yield* fs.makeTempDirectoryScoped();

    if (contents !== undefined) yield* fs.writeFileString(home + "/settings.json", contents);

    const services = yield* Layer.build(
      Settings.layer
        .pipe(Layer.provide(Layer.succeed(ProjectDirectory, { directory: home })))
        .pipe(Layer.provide(TauHome.at(home))),
    );

    return Context.get(services, Settings).notifications;
  });

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | import("effect").Scope.Scope>,
) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)));

describe("notification settings", () => {
  test.each([
    { contents: undefined, expected: { enabled: true, sound: true } },
    { contents: "{}", expected: { enabled: true, sound: true } },
    { contents: '{"notifications":{}}', expected: { enabled: true, sound: true } },
    { contents: '{"notifications":{"enabled":false}}', expected: { enabled: false, sound: true } },
    { contents: '{"notifications":{"sound":false}}', expected: { enabled: true, sound: false } },
  ])("reads $contents", ({ contents, expected }) =>
    run(
      readNotifications(contents).pipe(
        Effect.map((actual) => {
          expect(actual).toEqual(expected);
        }),
      ),
    ),
  );

  test.each(["enabled", "sound"])("rejects a nonboolean %s", (setting) =>
    run(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          readNotifications('{"notifications":{"' + setting + '":"false"}}'),
        );

        expect(Exit.isFailure(exit) && String(exit.cause)).toContain(setting);
      }),
    ),
  );
});

const readProjectSettings = (global: string | undefined, project: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();

    const directory = yield* fs.makeTempDirectoryScoped();
    if (global !== undefined) yield* fs.writeFileString(home + "/settings.json", global);

    if (project !== undefined) {
      yield* fs.makeDirectory(directory + "/.tau");
      yield* fs.writeFileString(directory + "/.tau/settings.json", project);
    }

    return yield* Layer.build(
      Settings.layer.pipe(
        Layer.provide(TauHome.at(home)),
        Layer.provide(Layer.succeed(ProjectDirectory, { directory })),
      ),
    );
  });

describe("project settings", () => {
  test.each([undefined, "{}", '{"commit":{}}'])(
    "inherits global values with project %s",
    (project) =>
      run(
        Effect.gen(function* () {
          const services = yield* readProjectSettings(
            '{"commit":{"push":false,"avoidBreakingChanges":true},"model":"openai/global"}',
            project,
          );

          expect(Context.get(services, CommitSettings)).toEqual({
            push: false,
            avoidBreakingChanges: true,
          });

          expect(Context.get(services, Settings).run.model).toBe("openai/global");
        }),
      ),
  );

  test("applies defaults when neither file exists", () =>
    run(
      Effect.gen(function* () {
        const services = yield* readProjectSettings(undefined, undefined);

        expect(Context.get(services, CommitSettings)).toEqual({
          push: "ask",
          avoidBreakingChanges: false,
        });

        expect(Context.get(services, Settings).agentsFiles).toBe(true);
      }),
    ));

  test("merges project fields before defaults and preserves explicit booleans", () =>
    run(
      Effect.gen(function* () {
        const services = yield* readProjectSettings(
          '{"commit":{"push":false,"avoidBreakingChanges":true},"agentsFiles":false,"model":"openai/global","maxTurns":12,"timeouts":{"run":300,"shell":20},"compaction":{"method":"off","budgetTokens":80000},"notifications":{"enabled":false,"sound":true}}',
          '{/* project */ "commit":{"avoidBreakingChanges":false},"agentsFiles":true,"model":"openai/project","timeouts":{"shell":40},"compaction":{"method":"notes"},"notifications":{"sound":false}}',
        );

        expect(Context.get(services, CommitSettings)).toEqual({
          push: false,
          avoidBreakingChanges: false,
        });

        const settings = Context.get(services, Settings);
        expect(settings.agentsFiles).toBe(true);

        expect(settings.run).toEqual({
          model: "openai/project",
          maxTurns: 12,
          runTimeoutSeconds: 300,
          shellTimeoutSeconds: 40,
        });

        expect(settings.notifications).toEqual({ enabled: false, sound: false });

        expect(Context.get(services, ContextSettings)).toEqual({
          method: "notes",
          budgetTokens: 80000,
        });
      }),
    ));

  test("loads project-only settings", () =>
    run(
      Effect.gen(function* () {
        const services = yield* readProjectSettings(
          undefined,
          '{"commit":{"avoidBreakingChanges":true}}',
        );

        expect(Context.get(services, CommitSettings)).toEqual({
          push: "ask",
          avoidBreakingChanges: true,
        });
      }),
    ));

  test("merges provider connections and nested model settings", () =>
    run(
      Effect.gen(function* () {
        const services = yield* readProjectSettings(
          '{"providers":{"local":{"protocol":"openaiChat","apiUrl":"http://localhost:1/v1","apiKeyEnv":"LOCAL_KEY","models":{"example":{"contextTokens":10000,"outputTokens":1000}}}}}',
          '{"providers":{"local":{"smallModel":"example","models":{"example":{"outputTokens":2000}}}}}',
        );

        const table = Context.get(services, ProviderTable);

        const local = table.providers.find(({ id }) => id === ProviderId.make("local"));
        expect(local?.apiUrl).toBe("http://localhost:1/v1");

        expect(local?.smallModel).toBe("example");
        expect(local?.auth).toEqual({ kind: "apiKey", environmentVariable: "LOCAL_KEY" });

        expect(table.settings.get(ProviderId.make("local"))?.models.example).toEqual({
          contextTokens: 10000,
          outputTokens: 2000,
        });
      }),
    ));

  test.each([
    { project: "{", message: "not valid JSON" },
    { project: '{"commit":{"avoidBreakingChanges":"true"}}', message: "avoidBreakingChanges" },
    {
      project: '{"providers":{"openai":{"apiUrl":"http://localhost:1"}}}',
      message: "providers.openai",
    },
    { project: '{"providers":{"local":{"smallModel":"example"}}}', message: "providers.local" },
  ])("rejects invalid project $project", ({ project, message }) =>
    run(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(readProjectSettings(undefined, project));
        expect(Exit.isFailure(exit) && String(exit.cause)).toContain("/.tau/settings.json");

        expect(Exit.isFailure(exit) && String(exit.cause)).toContain(message);
      }),
    ),
  );

  test("rejects an invalid global field even when the project overrides it", () =>
    run(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          readProjectSettings('{"agentsFiles":"false"}', '{"agentsFiles":true}'),
        );

        expect(Exit.isFailure(exit) && String(exit.cause)).toContain("agentsFiles");
      }),
    ));
});
