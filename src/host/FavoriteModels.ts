/** Keeps the user's favorite models in `~/.tau/favorites.json`, as a JSON array of `provider/model` texts. */

import { join } from "node:path";
import { Array, Crypto, Effect, FileSystem, Layer, Schema } from "effect";
import { formatModelRef, type ModelRef, parseModelRef } from "../ai/Catalog.ts";
import { FavoriteModels, FavoriteModelsError } from "../core/FavoriteModels.ts";
import { TauHome } from "../database/TauHome.ts";
import { replaceFile } from "./internal/replace-file.ts";

const FAVORITES_FILE = "favorites.json";

const FavoritesJson = Schema.fromJsonString(Schema.Array(Schema.String));

/** Keeps the favorites in `favorites.json` in Tau's home folder. */
export const favoriteModelsLayer = Layer.effect(
  FavoriteModels,
  TauHome.use((home) => makeFavoriteModels(home.directory)),
);

const makeFavoriteModels = Effect.fn("makeFavoriteModels")(function* (tauDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = join(tauDirectory, FAVORITES_FILE);

  // A missing or damaged file is not an error: the list starts empty, and the next toggle
  // writes a good file.
  const read = fileSystem.readFileString(path).pipe(
    Effect.flatMap(Schema.decodeEffect(FavoritesJson)),
    Effect.map((texts) => Array.getSomes(texts.map(parseModelRef))),
    Effect.orElseSucceed((): readonly ModelRef[] => []),
  );

  const write = (favorites: readonly ModelRef[]) =>
    Schema.encodeEffect(FavoritesJson)(favorites.map(formatModelRef)).pipe(
      Effect.flatMap((text) => replaceFile(tauDirectory, FAVORITES_FILE, text)),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError((cause) => new FavoriteModelsError({ path, cause })),
    );

  const toggle = Effect.fn("FavoriteModels.toggle")(function* (ref: ModelRef) {
    const favorites = yield* read;
    const isFavorite = favorites.some((favorite) => isSameModel(favorite, ref));

    const toggled = isFavorite
      ? favorites.filter((favorite) => !isSameModel(favorite, ref))
      : [...favorites, ref];

    yield* write(toggled);
    return toggled;
  });

  return FavoriteModels.of({ read, toggle });
});

const isSameModel = (left: ModelRef, right: ModelRef) =>
  left.provider === right.provider && left.model === right.model;
