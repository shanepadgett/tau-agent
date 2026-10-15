import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Context, Effect, Exit, FileSystem, Layer } from "effect";
import { TauHome } from "../../src/database/TauHome.ts";
import { Settings } from "../../src/host/Settings.ts";

const readNotifications = (contents: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const home = yield* fs.makeTempDirectoryScoped();

    if (contents !== undefined) yield* fs.writeFileString(home + "/settings.json", contents);

    const services = yield* Layer.build(Settings.layer.pipe(Layer.provide(TauHome.at(home))));

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
