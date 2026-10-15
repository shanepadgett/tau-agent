import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Schema, Scope } from "effect";
import { join } from "node:path";
import { ProviderId } from "../../src/ai/Providers.ts";
import { FavoriteModels } from "../../src/core/FavoriteModels.ts";
import { TauHome } from "../../src/database/TauHome.ts";
import { favoriteModelsLayer } from "../../src/host/FavoriteModels.ts";

const SavedJson = Schema.fromJsonString(Schema.Array(Schema.String));

const SONNET = { provider: ProviderId.make("anthropic"), model: "claude-sonnet-5-5" };
const HAIKU = { provider: ProviderId.make("openrouter"), model: "anthropic/claude-haiku-5.5" };

/** Runs `use` on the favorites of a new Tau home, after `prepare` sets up the home. */
const withFavorites = <A, E>(
  use: (favorites: FavoriteModels["Service"], home: string) => Effect.Effect<A, E>,
  prepare: (home: string) => Effect.Effect<void, unknown, FileSystem.FileSystem> = () =>
    Effect.void,
) =>
  Effect.gen(function* () {
    const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    yield* prepare(home);

    const layer = favoriteModelsLayer.pipe(
      Layer.provide(TauHome.at(home)),
      Layer.provide(BunServices.layer),
    );

    return yield* FavoriteModels.use((favorites) => use(favorites, home)).pipe(
      Effect.provide(layer),
    );
  });

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)));

describe("favorite models", () => {
  test("start empty, and a toggle adds a model, then removes it", () =>
    run(
      withFavorites((favorites, home) =>
        Effect.gen(function* () {
          expect(yield* favorites.read).toEqual([]);
          expect(yield* favorites.toggle(SONNET)).toEqual([SONNET]);
          expect(yield* favorites.toggle(HAIKU)).toEqual([SONNET, HAIKU]);

          const saved = yield* (yield* FileSystem.FileSystem).readFileString(
            join(home, "favorites.json"),
          );

          expect(yield* Schema.decodeEffect(SavedJson)(saved)).toEqual([
            "anthropic/claude-sonnet-5-5",
            "openrouter/anthropic/claude-haiku-5.5",
          ]);

          expect(yield* favorites.toggle(SONNET)).toEqual([HAIKU]);
          expect(yield* favorites.read).toEqual([HAIKU]);
        }).pipe(Effect.provide(BunServices.layer)),
      ),
    ));

  test("a damaged file reads as empty, and the next toggle writes a good one", () =>
    run(
      withFavorites(
        (favorites) =>
          Effect.gen(function* () {
            expect(yield* favorites.read).toEqual([]);
            expect(yield* favorites.toggle(SONNET)).toEqual([SONNET]);
            expect(yield* favorites.read).toEqual([SONNET]);
          }),
        (home) =>
          FileSystem.FileSystem.use((fileSystem) =>
            fileSystem.writeFileString(join(home, "favorites.json"), "{not json"),
          ),
      ),
    ));
});
