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

export const SHORT_TERM_MEMORY_TABLE =
  "CREATE TABLE short_term_memory (session_id TEXT NOT NULL REFERENCES session (id), " +
  "number INTEGER NOT NULL, from_entry INTEGER NOT NULL, through_entry INTEGER NOT NULL, " +
  "text TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL, " +
  "PRIMARY KEY (session_id, number)) STRICT";

export const LONG_TERM_MEMORY_TABLE =
  "CREATE TABLE long_term_memory (session_id TEXT NOT NULL REFERENCES session (id), " +
  "number INTEGER NOT NULL, through_short_term INTEGER NOT NULL, through_entry INTEGER NOT NULL, " +
  "text TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL, " +
  "PRIMARY KEY (session_id, number)) STRICT";

type NewShortTermMemory = {
  readonly from: number;
  readonly through: number;
  readonly text: string;
  readonly model: ModelRef;
};

export type ShortTermMemory = NewShortTermMemory & {
  readonly number: number;
  readonly at: DateTime.Utc;
};

/** `parent` is the number of the newest memory the writer read, or none. */
type NewLongTermMemory = {
  readonly parent: number | undefined;
  readonly throughShortTerm: number;
  readonly text: string;
  readonly model: ModelRef;
};

/** Folds notes 1 through `throughShortTerm`, which end at entry `throughEntry`. A newer memory replaces it. */
export type LongTermMemory = Omit<NewLongTermMemory, "parent"> & {
  readonly number: number;
  readonly throughEntry: number;
  readonly at: DateTime.Utc;
};

class LongTermMemoryConflict extends Schema.TaggedError<LongTermMemoryConflict>()(
  "LongTermMemoryConflict",
  {
    session: SessionId,
    reason: Schema.Literals([
      "newer memory exists",
      "short-term memory missing",
      "no new short-term memory",
    ]),
  },
) {}

const LongTermRow = Schema.Struct({
  session_id: SessionId,
  number: Schema.Int,
  through_short_term: Schema.Int,
  through_entry: Schema.Int,
  text: Schema.String,
  provider: ProviderId,
  model: Schema.String,
  at: Schema.DateTimeUtcFromMillis,
});

const ShortTermRow = Schema.Struct({
  session_id: SessionId,
  number: Schema.Int,
  from_entry: Schema.Int,
  through_entry: Schema.Int,
  text: Schema.String,
  provider: ProviderId,
  model: Schema.String,
  at: Schema.DateTimeUtcFromMillis,
});

export class Memories extends Context.Service<
  Memories,
  {
    readonly appendShortTerm: (
      session: SessionId,
      note: NewShortTermMemory,
    ) => Effect.Effect<ShortTermMemory, SessionStoreError>;
    readonly shortTerm: (
      session: SessionId,
    ) => Effect.Effect<readonly ShortTermMemory[], SessionStoreError>;
    readonly longTerm: (
      session: SessionId,
    ) => Effect.Effect<readonly LongTermMemory[], SessionStoreError>;
    /** Fails when a newer memory exists, the note is missing, or the memory folds no new note. */
    readonly appendLongTerm: (
      session: SessionId,
      memory: NewLongTermMemory,
    ) => Effect.Effect<LongTermMemory, LongTermMemoryConflict | SessionStoreError>;
  }
>()("tau/session/Memories") {}

const readShortTerm = (database: Database, session: SessionId) =>
  database
    .query(
      "SELECT * FROM short_term_memory WHERE session_id = ? ORDER BY number",
      [session],
      ShortTermRow,
    )
    .pipe(Effect.map((rows) => rows.map(shortTermFromRow)));

const readLongTerm = (database: Database, session: SessionId) =>
  database
    .query(
      "SELECT * FROM long_term_memory WHERE session_id = ? ORDER BY number",
      [session],
      LongTermRow,
    )
    .pipe(Effect.map((rows) => rows.map(longTermFromRow)));

/** Uses the connection that Sessions opened and migrated. */
export const makeMemories = (database: Database, path: string) => {
  const fail = (cause: unknown) => new SessionStoreError({ path, cause });

  const shortTerm = (session: SessionId) =>
    readShortTerm(database, session).pipe(Effect.mapError(fail));

  const appendShortTerm = (session: SessionId, note: NewShortTermMemory) =>
    database
      .writeTransaction(
        Effect.fn("Memories.appendShortTerm")(function* (transaction: Transaction) {
          const saved = yield* shortTerm(session);
          const number = (saved.at(-1)?.number ?? 0) + 1;
          const at = yield* DateTime.now;

          yield* transaction.run("INSERT INTO short_term_memory VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
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

  const longTerm = (session: SessionId) =>
    readLongTerm(database, session).pipe(Effect.mapError(fail));

  const appendLongTerm = (session: SessionId, memory: NewLongTermMemory) =>
    database
      .writeTransaction(
        Effect.fn("Memories.appendLongTerm")(function* (transaction: Transaction) {
          const newest = (yield* longTerm(session)).at(-1);

          if (newest?.number !== memory.parent)
            return yield* new LongTermMemoryConflict({ session, reason: "newer memory exists" });

          const note = (yield* shortTerm(session)).find(
            ({ number }) => number === memory.throughShortTerm,
          );

          if (note === undefined)
            return yield* new LongTermMemoryConflict({
              session,
              reason: "short-term memory missing",
            });

          if (memory.throughShortTerm <= (newest?.throughShortTerm ?? 0))
            return yield* new LongTermMemoryConflict({
              session,
              reason: "no new short-term memory",
            });

          return yield* insertMemory(transaction, { session, memory, newest, note });
        }),
      )
      .pipe(Effect.catchTag("DatabaseError", (error) => Effect.fail(fail(error))));

  return Memories.of({ appendShortTerm, shortTerm, longTerm, appendLongTerm });
};

type InsertedMemory = {
  readonly session: SessionId;
  readonly memory: NewLongTermMemory;
  readonly newest: LongTermMemory | undefined;
  readonly note: ShortTermMemory;
};

const insertMemory = Effect.fn("Memories.insertMemory")(function* (
  transaction: Transaction,
  { session, memory, newest, note }: InsertedMemory,
) {
  const number = (newest?.number ?? 0) + 1;
  const at = yield* DateTime.now;

  yield* transaction.run("INSERT INTO long_term_memory VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    session,
    number,
    memory.throughShortTerm,
    note.through,
    memory.text,
    memory.model.provider,
    memory.model.model,
    DateTime.toEpochMillis(at),
  ]);

  return {
    number,
    throughShortTerm: memory.throughShortTerm,
    throughEntry: note.through,
    text: memory.text,
    model: memory.model,
    at,
  };
});

const longTermFromRow = (row: typeof LongTermRow.Type): LongTermMemory => ({
  number: row.number,
  throughShortTerm: row.through_short_term,
  throughEntry: row.through_entry,
  text: row.text,
  model: { provider: row.provider, model: row.model },
  at: row.at,
});

const shortTermFromRow = (row: typeof ShortTermRow.Type): ShortTermMemory => ({
  number: row.number,
  from: row.from_entry,
  through: row.through_entry,
  text: row.text,
  model: { provider: row.provider, model: row.model },
  at: row.at,
});
