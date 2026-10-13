/** Keeps the model catalog cache in `~/.tau/catalog.json`. Tau can delete this file at any time and get it again. */

import { join } from "node:path";
import { Crypto, Effect, FileSystem, Layer, Schema } from "effect";
import { CatalogCache, CatalogCacheError, CatalogData } from "../ai/catalog.ts";

const CatalogJson = Schema.fromJsonString(CatalogData);

/** Keeps the cache in `catalog.json` inside `tauDirectory`, normally `~/.tau`. */
export const catalogCacheLayer = (tauDirectory: string) =>
  Layer.effect(CatalogCache, makeCatalogCache(tauDirectory));

const makeCatalogCache = Effect.fn("makeCatalogCache")(function* (tauDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = join(tauDirectory, "catalog.json");

  // A missing or damaged cache is not an error: the catalog starts from the copy in the binary.
  const read = fileSystem
    .readFileString(path)
    .pipe(Effect.flatMap(Schema.decodeEffect(CatalogJson)), Effect.option);

  // Two Tau processes can refresh at the same time. Each one writes a temporary file and renames
  // it, so a reader never sees half a file.
  const write = (catalogData: CatalogData) =>
    Effect.gen(function* () {
      const text = yield* Schema.encodeEffect(CatalogJson)(catalogData);
      const temporary = `${path}.${yield* crypto.randomUUIDv4()}`;
      yield* fileSystem.makeDirectory(tauDirectory, { recursive: true });
      yield* fileSystem.writeFileString(temporary, text);
      yield* fileSystem.rename(temporary, path);
    }).pipe(Effect.mapError((cause) => new CatalogCacheError({ path, cause })));

  return CatalogCache.of({ read, write });
});
