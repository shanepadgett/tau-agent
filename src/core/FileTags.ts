/** Finds the rows of the `@` list: files and folders of the session's folder or an attached reference, and the attached references. */

import { homedir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { FileIndex, type Search } from "../workspace/FileIndex.ts";
import { References } from "./References.ts";

/**
 * `path` is what a query holds to reach the row, such as `opencode/src/` in a reference; `tag`
 * is what the prompt gets, such as `~/.tau/references/opencode/src/`. A folder's path ends in `/`.
 * A reference's `tag` is its folder.
 */
export type TagRow =
  | { readonly kind: "file" | "folder"; readonly path: string; readonly tag: string }
  | { readonly kind: "reference"; readonly name: string; readonly tag: string };

export type TagSearch =
  | Exclude<Search, { readonly state: "ready" }>
  | { readonly state: "ready"; readonly rows: readonly TagRow[] };

/** FFF's rows for one query. References come after them. */
const ROWS = 10;

export class FileTags extends Context.Service<
  FileTags,
  {
    /** The rows for `query`, the text after `@`, in session folder `directory`. */
    readonly find: (
      directory: string,
      attached: readonly string[],
      query: string,
    ) => Effect.Effect<TagSearch>;
    /** Tells the index that the user chose `row` for `query`, to rank it higher next time. */
    readonly chose: (
      directory: string,
      attached: readonly string[],
      query: string,
      row: Extract<TagRow, { kind: "file" | "folder" }>,
    ) => Effect.Effect<void>;
  }
>()("tau/core/FileTags") {
  static readonly layer = Layer.effect(
    FileTags,
    Effect.gen(function* () {
      const index = yield* FileIndex;
      const references = yield* References;

      /** The folder a query searches, the rest of the query, and the reference's prefix if any. */
      const scopeOf = (directory: string, attached: readonly string[], query: string) => {
        const slash = query.indexOf("/");
        const name = query.slice(0, slash);

        if (slash > 0 && attached.includes(name)) {
          const folder = join(references.folder, name);
          return { folder, rest: query.slice(slash + 1), prefix: `${name}/`, tagFolder: folder };
        }

        return { folder: directory, rest: query, prefix: "", tagFolder: undefined };
      };

      const find = Effect.fn("FileTags.find")(function* (
        directory: string,
        attached: readonly string[],
        query: string,
      ) {
        const scope = scopeOf(directory, attached, query);
        const search = yield* index.search(scope.folder, scope.rest, ROWS);
        if (search.state !== "ready") return search;

        const found = search.found.map((one): TagRow => ({
          kind: one.kind,
          path: scope.prefix + one.path,
          tag:
            scope.tagFolder === undefined ? one.path : homeShort(join(scope.tagFolder, one.path)),
        }));

        const named = scope.prefix === "" ? attached.filter((name) => name.startsWith(query)) : [];

        const rows = [
          ...found,
          ...named.map((name): TagRow => ({
            kind: "reference",
            name,
            tag: `${homeShort(join(references.folder, name))}/`,
          })),
        ];

        return { state: "ready", rows } satisfies TagSearch;
      });

      const chose = (
        directory: string,
        attached: readonly string[],
        query: string,
        row: Extract<TagRow, { kind: "file" | "folder" }>,
      ) => {
        const scope = scopeOf(directory, attached, query);
        return index.chose(scope.folder, scope.rest, row.path.slice(scope.prefix.length));
      };

      return FileTags.of({ find, chose });
    }),
  );
}

/** `~/.tau/references/opencode/a.ts` reads better in a prompt than the whole home path. */
const homeShort = (path: string) => {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};
