/**
 * Stores sessions and their entries in `~/.tau/sessions.db`. A branch is a new session that starts
 * with a copy of its parent's entries.
 */

import { join } from "node:path";
import { Context, Crypto, DateTime, Effect, Layer, Schema } from "effect";
import { type Database, openDatabase, type Transaction } from "../database/database.ts";
import { type Entry, EntryBody, SessionId } from "./entry.ts";

const MIGRATIONS = [
  "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, origin TEXT NOT NULL, " +
    "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT",
  "CREATE TABLE entry (session_id TEXT NOT NULL REFERENCES session (id), " +
    "number INTEGER NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, " +
    "PRIMARY KEY (session_id, number)) STRICT",
];

const Origin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("new") }),
  Schema.Struct({ kind: Schema.Literal("fork"), from: SessionId, through: Schema.Int }),
]);

type Origin = typeof Origin.Type;

export type Session = {
  readonly id: SessionId;
  readonly directory: string;
  readonly origin: Origin;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
};

const OriginJson = Schema.fromJsonString(Origin);
const BodyJson = Schema.fromJsonString(EntryBody);

const SessionRow = Schema.Struct({
  id: SessionId,
  directory: Schema.String,
  origin: OriginJson,
  created_at: Schema.DateTimeUtcFromMillis,
  updated_at: Schema.DateTimeUtcFromMillis,
});

const EntryRow = Schema.Struct({
  session_id: SessionId,
  number: Schema.Int,
  at: Schema.DateTimeUtcFromMillis,
  body: BodyJson,
});

const LastNumber = Schema.Struct({ last: Schema.Int });

const SESSION_COLUMNS = "id, directory, origin, created_at, updated_at";

export class SessionStoreError extends Schema.TaggedError<SessionStoreError>()(
  "SessionStoreError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  session: SessionId,
}) {}

class EntryNotFound extends Schema.TaggedError<EntryNotFound>()("EntryNotFound", {
  session: SessionId,
  number: Schema.Int,
}) {}

export class Sessions extends Context.Service<
  Sessions,
  {
    readonly create: (directory: string) => Effect.Effect<Session, SessionStoreError>;

    readonly get: (id: SessionId) => Effect.Effect<Session, SessionNotFound | SessionStoreError>;

    /** Starts a new session with copies of entries 1 to `through` of `from`. */
    readonly fork: (
      from: SessionId,
      through: number,
    ) => Effect.Effect<Session, SessionNotFound | EntryNotFound | SessionStoreError>;

    /** The sessions started in `directory`, most recently changed first. */
    readonly list: (directory: string) => Effect.Effect<readonly Session[], SessionStoreError>;

    readonly append: (
      session: SessionId,
      bodies: readonly EntryBody[],
    ) => Effect.Effect<readonly Entry[], SessionNotFound | SessionStoreError>;

    /** The entries numbered above `after`, in order. Pass 0 for all of them. */
    readonly entries: (
      session: SessionId,
      after: number,
    ) => Effect.Effect<readonly Entry[], SessionStoreError>;
  }
>()("tau/session/Sessions") {}

/** Stores sessions in `sessions.db` inside `tauDirectory`, normally `~/.tau`. */
export const sessionsLayer = (tauDirectory: string) =>
  Layer.effect(Sessions, makeSessions(join(tauDirectory, "sessions.db")));

type NewSession = (directory: string, origin: Origin) => Effect.Effect<Session>;

const makeSessions = Effect.fn("makeSessions")(function* (path: string) {
  const fail = (cause: unknown) => new SessionStoreError({ path, cause });
  const database = yield* openDatabase(path, MIGRATIONS).pipe(Effect.mapError(fail));
  const crypto = yield* Crypto.Crypto;

  // UUIDv7 starts with the time, so IDs sort by creation.
  const newSession: NewSession = (directory, origin) =>
    Effect.all({ id: crypto.randomUUIDv7().pipe(Effect.orDie), now: DateTime.now }).pipe(
      Effect.map(({ id, now }) => ({
        id: SessionId.make(id),
        directory,
        origin,
        createdAt: now,
        updatedAt: now,
      })),
    );

  const create = (directory: string) =>
    newSession(directory, { kind: "new" }).pipe(
      Effect.tap((session) =>
        database.writeTransaction((transaction) => insertSession(transaction, session)),
      ),
      Effect.mapError(fail),
    );

  const fork = (from: SessionId, through: number) =>
    database
      .writeTransaction(forkWithin(database, newSession, from, through))
      .pipe(Effect.catchTag("DatabaseError", (error) => Effect.fail(fail(error))));

  const list = (directory: string) =>
    database
      .query(
        `SELECT ${SESSION_COLUMNS} FROM session WHERE directory = ? ` +
          "ORDER BY updated_at DESC, id DESC",
        [directory],
        SessionRow,
      )
      .pipe(
        Effect.map((rows) => rows.map(sessionFromRow)),
        Effect.mapError(fail),
      );

  const append = (session: SessionId, bodies: readonly EntryBody[]) =>
    database
      .writeTransaction(appendWithin(database, session, bodies))
      .pipe(Effect.catchTag("DatabaseError", (error) => Effect.fail(fail(error))));

  const entries = (session: SessionId, after: number) =>
    database
      .query(
        "SELECT session_id, number, at, body FROM entry " +
          "WHERE session_id = ? AND number > ? ORDER BY number",
        [session, after],
        EntryRow,
      )
      .pipe(
        Effect.map((rows) => rows.map(entryFromRow)),
        Effect.mapError(fail),
      );

  const get = (id: SessionId) =>
    readSession(database, id).pipe(
      Effect.catchTag("DatabaseError", (error) => Effect.fail(fail(error))),
    );

  return Sessions.of({ create, get, fork, list, append, entries });
});

const forkWithin = (database: Database, newSession: NewSession, from: SessionId, through: number) =>
  Effect.fn("Sessions.fork")(function* (transaction: Transaction) {
    const parent = yield* readSession(database, from);
    const isEntry = through >= 1 && through <= (yield* lastNumber(database, from));
    if (!isEntry) return yield* new EntryNotFound({ session: from, number: through });

    const branch = yield* newSession(parent.directory, { kind: "fork", from, through });
    yield* insertSession(transaction, branch);

    yield* transaction.run(
      "INSERT INTO entry (session_id, number, at, body) " +
        "SELECT ?, number, at, body FROM entry WHERE session_id = ? AND number <= ?",
      [branch.id, from, through],
    );

    return branch;
  });

const appendWithin = (database: Database, session: SessionId, bodies: readonly EntryBody[]) =>
  Effect.fn("Sessions.append")(function* (transaction: Transaction) {
    yield* readSession(database, session);
    const last = yield* lastNumber(database, session);
    const at = yield* DateTime.now;

    const entries = bodies.map((body, index): Entry => ({
      session,
      number: last + index + 1,
      at,
      body,
    }));

    yield* Effect.forEach(entries, (entry) => insertEntry(transaction, entry));

    yield* transaction.run("UPDATE session SET updated_at = ? WHERE id = ?", [
      DateTime.toEpochMillis(at),
      session,
    ]);

    return entries;
  });

const readSession = (database: Database, id: SessionId) =>
  database.query(`SELECT ${SESSION_COLUMNS} FROM session WHERE id = ?`, [id], SessionRow).pipe(
    Effect.flatMap((rows) => {
      const [row] = rows;
      if (row === undefined) return Effect.fail(new SessionNotFound({ session: id }));
      return Effect.succeed(sessionFromRow(row));
    }),
  );

const lastNumber = (database: Database, session: SessionId) =>
  database
    .query(
      "SELECT COALESCE(MAX(number), 0) AS last FROM entry WHERE session_id = ?",
      [session],
      LastNumber,
    )
    .pipe(Effect.map((rows) => rows[0]?.last ?? 0));

const sessionFromRow = (row: typeof SessionRow.Type): Session => ({
  id: row.id,
  directory: row.directory,
  origin: row.origin,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const entryFromRow = (row: typeof EntryRow.Type): Entry => ({
  session: row.session_id,
  number: row.number,
  at: row.at,
  body: row.body,
});

// A decoded value always encodes; a failure here is a bug in the schema.
const encodeJson = <S extends Schema.Codec<unknown, string>>(schema: S, value: S["Type"]) =>
  Schema.encodeEffect(schema)(value).pipe(Effect.orDie);

const insertSession = (transaction: Transaction, session: Session) =>
  encodeJson(OriginJson, session.origin).pipe(
    Effect.flatMap((origin) =>
      transaction.run(`INSERT INTO session (${SESSION_COLUMNS}) VALUES (?, ?, ?, ?, ?)`, [
        session.id,
        session.directory,
        origin,
        DateTime.toEpochMillis(session.createdAt),
        DateTime.toEpochMillis(session.updatedAt),
      ]),
    ),
  );

const insertEntry = (transaction: Transaction, entry: Entry) =>
  encodeJson(BodyJson, entry.body).pipe(
    Effect.flatMap((body) =>
      transaction.run("INSERT INTO entry (session_id, number, at, body) VALUES (?, ?, ?, ?)", [
        entry.session,
        entry.number,
        DateTime.toEpochMillis(entry.at),
        body,
      ]),
    ),
  );
