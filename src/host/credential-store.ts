/** Keeps API keys and OAuth tokens in `~/.tau/credentials.db`, refreshing tokens one process at a time. */

import { join } from "node:path";
import { Effect, Layer, Option, Schema } from "effect";
import {
  Credential,
  CredentialStore,
  CredentialStoreError,
  type ProviderId,
} from "../ai/credential.ts";
import { openDatabase, type Transaction } from "../database/database.ts";

const MIGRATIONS = [
  "CREATE TABLE credential (provider TEXT PRIMARY KEY, credential TEXT NOT NULL) STRICT",
];

const CredentialJson = Schema.fromJsonString(Credential);
const StoredCredential = Schema.Struct({ credential: CredentialJson });
const isSameCredential = Schema.toEquivalence(Credential);

/** Stores credentials in `credentials.db` inside `tauDirectory`, normally `~/.tau`. */
export const credentialStoreLayer = (tauDirectory: string) =>
  Layer.effect(CredentialStore, makeCredentialStore(join(tauDirectory, "credentials.db")));

const makeCredentialStore = Effect.fn("makeCredentialStore")(function* (path: string) {
  const fail = (cause: unknown) => new CredentialStoreError({ path, cause });
  const database = yield* openDatabase(path, MIGRATIONS).pipe(Effect.mapError(fail));

  const read = (provider: ProviderId) =>
    database
      .query("SELECT credential FROM credential WHERE provider = ?", [provider], StoredCredential)
      .pipe(
        Effect.map((rows) => Option.fromUndefinedOr(rows[0]?.credential)),
        Effect.mapError(fail),
      );

  const save = (provider: ProviderId, credential: Credential) =>
    database
      .writeTransaction((transaction) => saveEntry(transaction, { provider, credential }))
      .pipe(Effect.mapError(fail));

  const remove = (provider: ProviderId) =>
    database
      .writeTransaction((transaction) => removeEntry(transaction, provider))
      .pipe(Effect.mapError(fail));

  const update = <E>(
    provider: ProviderId,
    stale: Credential,
    refresh: (stale: Credential) => Effect.Effect<Credential, E>,
  ) =>
    database
      .writeTransaction((transaction) =>
        read(provider).pipe(
          Effect.flatMap((stored) => {
            const isReplaced = Option.isNone(stored) || !isSameCredential(stored.value, stale);
            if (isReplaced) return Effect.succeed(stored);

            return refresh(stale).pipe(
              Effect.tap((fresh) => saveEntry(transaction, { provider, credential: fresh })),
              Effect.map(Option.some),
            );
          }),
        ),
      )
      .pipe(Effect.catchTag("DatabaseError", (error) => Effect.fail(fail(error))));

  return CredentialStore.of({ read, save, remove, update });
});

type Entry = { readonly provider: ProviderId; readonly credential: Credential };

const saveEntry = (transaction: Transaction, entry: Entry) =>
  Schema.encodeEffect(CredentialJson)(entry.credential).pipe(
    // A decoded credential always encodes; a failure here is a bug in the schema.
    Effect.orDie,
    Effect.flatMap((encoded) =>
      transaction.run(
        "INSERT INTO credential (provider, credential) VALUES (?, ?) " +
          "ON CONFLICT (provider) DO UPDATE SET credential = excluded.credential",
        [entry.provider, encoded],
      ),
    ),
  );

const removeEntry = (transaction: Transaction, provider: ProviderId) =>
  transaction.run("DELETE FROM credential WHERE provider = ?", [provider]);
