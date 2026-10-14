/** Stores append-only notes on entry ranges in the session database. Forks keep their note numbers. */

import { Context, DateTime, Effect, Schema } from "effect";
import type { ModelRef } from "../ai/Catalog.ts";
import { RouteId } from "../ai/Routes.ts";
import type { Database, Transaction } from "../database/Database.ts";
import { SessionId } from "./Entry.ts";
import { SessionStoreError } from "./SessionStoreError.ts";

export const NOTE_TABLE =
  "CREATE TABLE note (session_id TEXT NOT NULL REFERENCES session (id), " +
  "number INTEGER NOT NULL, from_entry INTEGER NOT NULL, through_entry INTEGER NOT NULL, " +
  "text TEXT NOT NULL, route TEXT NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL, " +
  "PRIMARY KEY (session_id, number)) STRICT";

type NewNote = {
  readonly from: number;
  readonly through: number;
  readonly text: string;
  readonly model: ModelRef;
};

export type Note = NewNote & { readonly number: number; readonly at: DateTime.Utc };

const NoteRow = Schema.Struct({
  session_id: SessionId,
  number: Schema.Int,
  from_entry: Schema.Int,
  through_entry: Schema.Int,
  text: Schema.String,
  route: RouteId,
  model: Schema.String,
  at: Schema.DateTimeUtcFromMillis,
});

export class Notes extends Context.Service<
  Notes,
  {
    readonly append: (session: SessionId, note: NewNote) => Effect.Effect<Note, SessionStoreError>;
    readonly list: (session: SessionId) => Effect.Effect<readonly Note[], SessionStoreError>;
  }
>()("tau/session/Notes") {}

/** Uses the connection that Sessions opened and migrated. */
export const makeNotes = (database: Database, path: string) => {
  const fail = (cause: unknown) => new SessionStoreError({ path, cause });

  const list = (session: SessionId) =>
    database
      .query("SELECT * FROM note WHERE session_id = ? ORDER BY number", [session], NoteRow)
      .pipe(
        Effect.map((rows) => rows.map(noteFromRow)),
        Effect.mapError(fail),
      );

  const append = (session: SessionId, note: NewNote) =>
    database
      .writeTransaction(
        Effect.fn("Notes.append")(function* (transaction: Transaction) {
          const saved = yield* list(session);
          const number = (saved.at(-1)?.number ?? 0) + 1;
          const at = yield* DateTime.now;

          yield* transaction.run("INSERT INTO note VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
            session,
            number,
            note.from,
            note.through,
            note.text,
            note.model.route,
            note.model.model,
            DateTime.toEpochMillis(at),
          ]);

          return { ...note, number, at };
        }),
      )
      .pipe(Effect.mapError(fail));

  return Notes.of({ append, list });
};

const noteFromRow = (row: typeof NoteRow.Type): Note => ({
  number: row.number,
  from: row.from_entry,
  through: row.through_entry,
  text: row.text,
  model: { route: row.route, model: row.model },
  at: row.at,
});
