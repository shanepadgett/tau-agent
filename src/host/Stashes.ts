/** Keeps the stashed prompts in `~/.tau/stash.db`, one list for each project folder. */

import { join } from "node:path";
import { DateTime, Effect, Layer, Schema } from "effect";
import { openDatabase } from "../database/Database.ts";
import { TauHome } from "../database/TauHome.ts";
import { Stashes, StashesError } from "../core/Stashes.ts";

const MIGRATIONS = [
  "CREATE TABLE stash (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, " +
    "text TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (project, text)) STRICT",
];

const StashRow = Schema.Struct({
  id: Schema.Int,
  text: Schema.String,
  created_at: Schema.DateTimeUtcFromMillis,
});

const Existing = Schema.Struct({ id: Schema.Int });

/** Stores the stashes in `stash.db` in Tau's home folder. */
export const stashesLayer = Layer.effect(
  Stashes,
  TauHome.use((home) => makeStashes(join(home.directory, "stash.db"))),
);

const makeStashes = Effect.fn("makeStashes")(function* (path: string) {
  const fail = (cause: unknown) => new StashesError({ path, cause });
  const database = yield* openDatabase(path, MIGRATIONS).pipe(Effect.mapError(fail));

  const list = (project: string) =>
    database
      .query(
        "SELECT id, text, created_at FROM stash WHERE project = ? ORDER BY created_at DESC, id DESC",
        [project],
        StashRow,
      )
      .pipe(
        Effect.map((rows) =>
          rows.map((row) => ({ id: row.id, text: row.text, createdAt: row.created_at })),
        ),
        Effect.mapError(fail),
      );

  const add = Effect.fn("Stashes.add")(function* (project: string, text: string) {
    const held = yield* database.query(
      "SELECT id FROM stash WHERE project = ? AND text = ?",
      [project, text],
      Existing,
    );

    if (held.length > 0) return "duplicate" as const;

    const now = yield* DateTime.now;

    yield* database.writeTransaction((transaction) =>
      transaction.run(
        "INSERT INTO stash (project, text, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        [project, text, DateTime.toEpochMillis(now)],
      ),
    );

    return "stashed" as const;
  }, Effect.mapError(fail));

  const remove = (id: number) =>
    database
      .writeTransaction((transaction) => transaction.run("DELETE FROM stash WHERE id = ?", [id]))
      .pipe(Effect.mapError(fail));

  return Stashes.of({ list, add, remove });
});
