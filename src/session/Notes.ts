/**
 * Stores append-only notes on entry ranges, and the memories that fold older notes, in the session
 * database. Forks keep their note and memory numbers.
 */

import { Context, DateTime, Effect, Schema } from "effect";
import type { ModelRef } from "../ai/Catalog.ts";
import { ProviderId } from "../ai/Providers.ts";
import type { Database, Transaction } from "../database/Database.ts";
import { SessionId } from "./Entry.ts";
import { SessionStoreError } from "./SessionStoreError.ts";

export const NOTE_TABLE =
  "CREATE TABLE note (session_id TEXT NOT NULL REFERENCES session (id), " +
  "number INTEGER NOT NULL, from_entry INTEGER NOT NULL, through_entry INTEGER NOT NULL, " +
  "text TEXT NOT NULL, route TEXT NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL, " +
  "PRIMARY KEY (session_id, number)) STRICT";

export const MEMORY_TABLE =
  "CREATE TABLE memory (session_id TEXT NOT NULL REFERENCES session (id), " +
  "number INTEGER NOT NULL, through_note INTEGER NOT NULL, through_entry INTEGER NOT NULL, " +
  "text TEXT NOT NULL, route TEXT NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL, " +
  "PRIMARY KEY (session_id, number)) STRICT";

type NewNote = {
  readonly from: number;
  readonly through: number;
  readonly text: string;
  readonly model: ModelRef;
};

export type Note = NewNote & { readonly number: number; readonly at: DateTime.Utc };

/** `parent` is the number of the newest memory the writer read, or none. */
type NewMemory = {
  readonly parent: number | undefined;
  readonly throughNote: number;
  readonly text: string;
  readonly model: ModelRef;
};

/** Folds notes 1 through `throughNote`, which end at entry `throughEntry`. A newer memory replaces it. */
export type Memory = Omit<NewMemory, "parent"> & {
  readonly number: number;
  readonly throughEntry: number;
  readonly at: DateTime.Utc;
};

class MemoryConflict extends Schema.TaggedError<MemoryConflict>()("MemoryConflict", {
  session: SessionId,
  reason: Schema.Literals(["newer memory exists", "note missing", "no new notes"]),
}) {}

const MemoryRow = Schema.Struct({
  session_id: SessionId,
  number: Schema.Int,
  through_note: Schema.Int,
  through_entry: Schema.Int,
  text: Schema.String,
  provider: ProviderId,
  model: Schema.String,
  at: Schema.DateTimeUtcFromMillis,
});

const NoteRow = Schema.Struct({
  session_id: SessionId,
  number: Schema.Int,
  from_entry: Schema.Int,
  through_entry: Schema.Int,
  text: Schema.String,
  provider: ProviderId,
  model: Schema.String,
  at: Schema.DateTimeUtcFromMillis,
});

export class Notes extends Context.Service<
  Notes,
  {
    readonly append: (session: SessionId, note: NewNote) => Effect.Effect<Note, SessionStoreError>;
    readonly list: (session: SessionId) => Effect.Effect<readonly Note[], SessionStoreError>;
    readonly memories: (session: SessionId) => Effect.Effect<readonly Memory[], SessionStoreError>;
    /** Fails when a newer memory exists, the note is missing, or the memory folds no new note. */
    readonly appendMemory: (
      session: SessionId,
      memory: NewMemory,
    ) => Effect.Effect<Memory, MemoryConflict | SessionStoreError>;
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
            note.model.provider,
            note.model.model,
            DateTime.toEpochMillis(at),
          ]);

          return { ...note, number, at };
        }),
      )
      .pipe(Effect.mapError(fail));

  const memories = (session: SessionId) =>
    database
      .query("SELECT * FROM memory WHERE session_id = ? ORDER BY number", [session], MemoryRow)
      .pipe(
        Effect.map((rows) => rows.map(memoryFromRow)),
        Effect.mapError(fail),
      );

  const appendMemory = (session: SessionId, memory: NewMemory) =>
    database
      .writeTransaction(
        Effect.fn("Notes.appendMemory")(function* (transaction: Transaction) {
          const newest = (yield* memories(session)).at(-1);

          if (newest?.number !== memory.parent)
            return yield* new MemoryConflict({ session, reason: "newer memory exists" });

          const note = (yield* list(session)).find(({ number }) => number === memory.throughNote);

          if (note === undefined)
            return yield* new MemoryConflict({ session, reason: "note missing" });

          if (memory.throughNote <= (newest?.throughNote ?? 0))
            return yield* new MemoryConflict({ session, reason: "no new notes" });

          return yield* insertMemory(transaction, { session, memory, newest, note });
        }),
      )
      .pipe(Effect.catchTag("DatabaseError", (error) => Effect.fail(fail(error))));

  return Notes.of({ append, list, memories, appendMemory });
};

type InsertedMemory = {
  readonly session: SessionId;
  readonly memory: NewMemory;
  readonly newest: Memory | undefined;
  readonly note: Note;
};

const insertMemory = Effect.fn("Notes.insertMemory")(function* (
  transaction: Transaction,
  { session, memory, newest, note }: InsertedMemory,
) {
  const number = (newest?.number ?? 0) + 1;
  const at = yield* DateTime.now;

  yield* transaction.run("INSERT INTO memory VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    session,
    number,
    memory.throughNote,
    note.through,
    memory.text,
    memory.model.provider,
    memory.model.model,
    DateTime.toEpochMillis(at),
  ]);

  return {
    number,
    throughNote: memory.throughNote,
    throughEntry: note.through,
    text: memory.text,
    model: memory.model,
    at,
  };
});

const memoryFromRow = (row: typeof MemoryRow.Type): Memory => ({
  number: row.number,
  throughNote: row.through_note,
  throughEntry: row.through_entry,
  text: row.text,
  model: { provider: row.provider, model: row.model },
  at: row.at,
});

const noteFromRow = (row: typeof NoteRow.Type): Note => ({
  number: row.number,
  from: row.from_entry,
  through: row.through_entry,
  text: row.text,
  model: { provider: row.provider, model: row.model },
  at: row.at,
});
