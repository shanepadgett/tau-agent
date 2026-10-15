/**
 * Finds files and folders in a folder by a fuzzy query, through one FFF index per folder. An index
 * starts on the first search of its folder and lives until Tau stops.
 */

import { dirname, join } from "node:path";
import { FileFinder } from "@ff-labs/fff-bun";
import { Context, Duration, Effect, Layer, RcMap } from "effect";

/** A path relative to the searched folder. A folder's path ends in `/`. */
export type Found = { readonly kind: "file" | "folder"; readonly path: string };

/**
 * Off: FFF refuses a home folder and the file system root, which hold too many files, and is
 * unavailable when its native library does not load.
 */
export type Search =
  | { readonly state: "ready"; readonly found: readonly Found[] }
  | { readonly state: "indexing"; readonly scanned: number }
  | { readonly state: "off"; readonly reason: "home" | "root" | "unavailable" };

type Index =
  | { readonly state: "open"; readonly finder: FileFinder }
  | Extract<Search, { state: "off" }>;

/** The words of FFF's error for a home folder or the file system root. */
const TOO_WIDE = "file system root or home";

export class FileIndex extends Context.Service<
  FileIndex,
  {
    readonly search: (folder: string, query: string, limit: number) => Effect.Effect<Search>;
    /** Tells FFF that the user chose `path` for `query`, so it ranks the path higher next time. */
    readonly chose: (folder: string, query: string, path: string) => Effect.Effect<void>;
  }
>()("tau/workspace/FileIndex") {
  /** Keeps FFF's ranking databases, which every folder shares, in `databases`. */
  static readonly at = (databases: string) =>
    Layer.effect(
      FileIndex,
      Effect.gen(function* () {
        const indexes = yield* RcMap.make({
          lookup: (folder: string) => openIndex(folder, databases),
          idleTimeToLive: Duration.infinity,
        });

        const search = (folder: string, query: string, limit: number) =>
          RcMap.get(indexes, folder).pipe(
            Effect.map((index) =>
              index.state === "open" ? searchIn(index.finder, query, limit) : index,
            ),
            Effect.scoped,
          );

        const chose = (folder: string, query: string, path: string) =>
          RcMap.get(indexes, folder).pipe(
            Effect.tap((index) =>
              index.state === "open"
                ? trackChoice(index.finder, query, join(folder, path))
                : Effect.void,
            ),
            Effect.asVoid,
            Effect.scoped,
          );

        return FileIndex.of({ search, chose });
      }),
    );
}

const openIndex = (folder: string, databases: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const created = createFinder(folder, databases);
      if (created.ok) return { state: "open", finder: created.value } satisfies Index;

      if (created.error.includes(TOO_WIDE)) {
        const reason = dirname(folder) === folder ? "root" : "home";
        return { state: "off", reason } satisfies Index;
      }

      yield* Effect.logWarning(`File search could not start in ${folder}: ${created.error}`);
      return { state: "off", reason: "unavailable" } satisfies Index;
    }),
    (index: Index) =>
      Effect.sync(() => {
        if (index.state === "open") index.finder.destroy();
      }),
  );

/** FFF throws instead of failing when its native library does not load. */
const createFinder = (folder: string, databases: string) => {
  try {
    return FileFinder.create({
      basePath: folder,
      frecencyDbPath: join(databases, "frecency"),
      historyDbPath: join(databases, "history"),
      aiMode: true,
      // Tau searches names only, so FFF need not map or index file contents.
      disableMmapCache: true,
      disableContentIndexing: true,
    });
  } catch (cause) {
    return { ok: false as const, error: String(cause) };
  }
};

const searchIn = (finder: FileFinder, query: string, limit: number): Search => {
  const progress = finder.getScanProgress();

  if (progress.ok && progress.value.isScanning)
    return { state: "indexing", scanned: progress.value.scannedFilesCount };

  const searched = finder.mixedSearch(query, { pageSize: limit });
  if (!searched.ok) return { state: "ready", found: [] };

  // FFF lists the searched folder itself as the folder "".
  const found = searched.value.items.flatMap((item): Found[] =>
    item.item.relativePath === ""
      ? []
      : [{ kind: item.type === "file" ? "file" : "folder", path: item.item.relativePath }],
  );

  return { state: "ready", found };
};

const trackChoice = (finder: FileFinder, query: string, path: string) =>
  Effect.sync(() => finder.trackQuery(query, path)).pipe(
    Effect.tap((tracked) =>
      tracked.ok
        ? Effect.void
        : Effect.logWarning(`FFF did not record the choice of ${path}: ${tracked.error}`),
    ),
  );
