/** Opens private SQLite files. Runs write transactions that keep the lock during async work. */

import { Database as Connection, SQLiteError } from "bun:sqlite";
import { dirname } from "node:path";
import { Effect, FileSystem, Predicate, Schedule, Schema, Semaphore, type Scope } from "effect";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// SQLite's busy timeout waits synchronously and would freeze the event loop, so
// the connection fails at once and waiting happens on this schedule instead.
const BUSY_RETRY = Schedule.spaced("20 millis").pipe(Schedule.upTo({ duration: "30 seconds" }));

export type SqlValue = string | number | null;

class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  path: Schema.String,
  reason: Schema.Literals(["unopenable", "migrationFailed", "busyTimeout", "queryFailed"]),
  cause: Schema.Defect(),
}) {}

class DatabaseBusy extends Schema.TaggedError<DatabaseBusy>()("DatabaseBusy", {
  cause: Schema.Defect(),
}) {}

export interface Transaction {
  readonly run: (sql: string, params: readonly SqlValue[]) => Effect.Effect<void, DatabaseError>;
}

export interface Database {
  readonly query: <A>(
    sql: string,
    params: readonly SqlValue[],
    row: Schema.Decoder<A>,
  ) => Effect.Effect<readonly A[], DatabaseError>;

  /**
   * Runs `body` inside `BEGIN IMMEDIATE`, which holds SQLite's write lock across
   * processes. Commits when `body` succeeds; rolls back on failure or interruption.
   * Fails with `busyTimeout` when another process holds the lock for 30 seconds.
   */
  readonly writeTransaction: <A, E, R>(
    body: (transaction: Transaction) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DatabaseError, R>;
}

type DatabaseFile = { readonly path: string; readonly connection: Connection };

const UserVersion = Schema.Struct({ user_version: Schema.Int });

const failure = (path: string, reason: DatabaseError["reason"]) => (cause: unknown) =>
  new DatabaseError({ path, reason, cause });

/**
 * Opens the SQLite file at `path` for the life of the current scope. The file and
 * its WAL files are readable only by the owner. Migration `n` (1-based) runs once,
 * when the file's `user_version` is below `n`.
 */
export const openDatabase = Effect.fn("openDatabase")(function* (
  path: string,
  migrations: readonly string[],
): Effect.fn.Return<Database, DatabaseError, Scope.Scope | FileSystem.FileSystem> {
  const file: DatabaseFile = { path, connection: yield* connect(path) };

  // Fibers in this process share one connection, so they take turns: a second
  // BEGIN on the same connection would fail rather than wait.
  const writer = yield* Semaphore.make(1);

  const database: Database = {
    query: (sql, params, row) => query(file, { sql, params }, row),
    writeTransaction: (body) =>
      Semaphore.withPermit(writer)(
        Effect.acquireUseRelease(
          begin(file),
          () =>
            body({ run: (sql, params) => execute(file, { sql, params }) }).pipe(
              Effect.tap(() => execute(file, { sql: "COMMIT", params: [] })),
            ),
          () => rollbackIfOpen(file),
        ),
      ),
  };

  yield* migrate(database, migrations).pipe(Effect.mapError(failure(path, "migrationFailed")));
  return database;
});

const connect = Effect.fn("connect")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const fail = failure(path, "unopenable");
  const directory = dirname(path);
  yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(fail));
  yield* fileSystem.chmod(directory, PRIVATE_DIRECTORY_MODE).pipe(Effect.mapError(fail));

  const connection = yield* Effect.acquireRelease(
    Effect.try({ try: () => new Connection(path, { create: true, strict: true }), catch: fail }),
    (opened) =>
      Effect.sync(() => {
        opened.close();
      }),
  );

  // Set before the first write: SQLite gives WAL files the database file's mode.
  yield* fileSystem.chmod(path, PRIVATE_FILE_MODE).pipe(Effect.mapError(fail));

  yield* Effect.try({
    try: () => {
      connection.run("PRAGMA busy_timeout = 0");
      connection.run("PRAGMA journal_mode = WAL");
    },
    catch: fail,
  });

  return connection;
});

type Statement = { readonly sql: string; readonly params: readonly SqlValue[] };

const execute = (file: DatabaseFile, statement: Statement) =>
  Effect.try({
    try: () => {
      file.connection.run(statement.sql, [...statement.params]);
    },
    catch: failure(file.path, "queryFailed"),
  });

const query = <A>(file: DatabaseFile, statement: Statement, row: Schema.Decoder<A>) =>
  Effect.try({
    try: () => file.connection.query<unknown, SqlValue[]>(statement.sql).all(...statement.params),
    catch: failure(file.path, "queryFailed"),
  }).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (value) =>
        Schema.decodeUnknownEffect(row)(value).pipe(
          Effect.mapError(failure(file.path, "queryFailed")),
        ),
      ),
    ),
  );

const isBusy = (cause: unknown) =>
  cause instanceof SQLiteError && cause.code?.startsWith("SQLITE_BUSY") === true;

const begin = (file: DatabaseFile) =>
  Effect.try({
    try: () => {
      file.connection.run("BEGIN IMMEDIATE");
    },
    catch: (cause) =>
      isBusy(cause) ? new DatabaseBusy({ cause }) : failure(file.path, "queryFailed")(cause),
  }).pipe(
    Effect.retry({ schedule: BUSY_RETRY, while: Predicate.isTagged("DatabaseBusy") }),
    Effect.catchTag("DatabaseBusy", (busy) =>
      Effect.fail(failure(file.path, "busyTimeout")(busy.cause)),
    ),
  );

// After a commit the transaction is closed, so this acts only on failure or interruption.
const rollbackIfOpen = (file: DatabaseFile) =>
  Effect.sync(() => {
    if (file.connection.inTransaction) file.connection.run("ROLLBACK");
  });

const migrate = Effect.fn("migrate")(function* (database: Database, migrations: readonly string[]) {
  const [current] = yield* database.query("PRAGMA user_version", [], UserVersion);
  const applied = current?.user_version ?? 0;

  for (const [index, sql] of migrations.entries()) {
    const version = index + 1;
    if (version <= applied) continue;

    // PRAGMA takes no bound parameters; `version` is an integer from this loop.
    const setVersion = `PRAGMA user_version = ${version}`;

    yield* database.writeTransaction((transaction) =>
      transaction.run(sql, []).pipe(Effect.andThen(transaction.run(setVersion, []))),
    );
  }
});
