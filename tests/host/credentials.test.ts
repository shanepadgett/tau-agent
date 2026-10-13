import { describe, expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import {
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
  type Scope,
} from "effect";
import {
  ApiKey,
  Credential,
  CredentialStore,
  OAuthTokens,
  ProviderId,
} from "../../src/ai/Credential.ts";
import { TauHome } from "../../src/database/TauHome.ts";
import { credentialStoreLayer } from "../../src/host/CredentialStore.ts";

const PRIVATE_FILE = 0o600;
const PRIVATE_DIRECTORY = 0o700;
const PERMISSION_BITS = 0o777;

const anthropic = ProviderId.make("anthropic");
const isSameCredential = Schema.toEquivalence(Credential);

const tokens = (label: string, expiresAtMillis: number) =>
  OAuthTokens.make({
    access: Redacted.make(`access-${label}`),
    refresh: Redacted.make(`refresh-${label}`),
    expiresAt: DateTime.makeUnsafe(expiresAtMillis),
  });

const expired = tokens("expired", 1_000);
const refreshed = tokens("refreshed", 2_000);

const openStore = (tauDirectory: string) =>
  Layer.build(credentialStoreLayer.pipe(Layer.provide(TauHome.at(tauDirectory)))).pipe(
    Effect.map((context) => Context.get(context, CredentialStore)),
  );

const runInTempHome = <A, E>(
  program: (tauDirectory: string) => Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      return yield* program(`${home}/.tau`);
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)),
  );

const expectCredential = (stored: Option.Option<Credential>, expected: Credential) => {
  expect(Option.isSome(stored) && isSameCredential(stored.value, expected)).toBe(true);
};

describe("credential store", () => {
  test("saves, reads after reopening, and removes a credential", () =>
    runInTempHome((tauDirectory) =>
      Effect.gen(function* () {
        const apiKey = ApiKey.make({ key: Redacted.make("sk-test") });
        const writer = yield* openStore(tauDirectory);
        yield* writer.save(anthropic, apiKey);

        const reader = yield* openStore(tauDirectory);
        expectCredential(yield* reader.read(anthropic), apiKey);

        yield* reader.remove(anthropic);
        expect(Option.isNone(yield* writer.read(anthropic))).toBe(true);
      }),
    ));

  test("a second refresh returns the first refresh's tokens instead of refreshing again", () =>
    runInTempHome((tauDirectory) =>
      Effect.gen(function* () {
        const first = yield* openStore(tauDirectory);
        const second = yield* openStore(tauDirectory);
        yield* first.save(anthropic, expired);

        const refreshStarted = yield* Deferred.make<void>();
        const finishRefresh = yield* Deferred.make<void>();
        let secondRefreshCalls = 0;

        const firstUpdate = yield* Effect.forkChild(
          first.update(anthropic, expired, () =>
            Deferred.succeed(refreshStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishRefresh)),
              Effect.as(refreshed),
            ),
          ),
        );

        yield* Deferred.await(refreshStarted);

        const secondUpdate = yield* Effect.forkChild(
          second.update(anthropic, expired, () =>
            Effect.sync(() => {
              secondRefreshCalls += 1;
              return tokens("duplicate", 3_000);
            }),
          ),
        );

        // Let the second update reach the database while the first still holds it.
        yield* Effect.yieldNow;
        yield* Deferred.succeed(finishRefresh, undefined);
        expectCredential(yield* Fiber.join(firstUpdate), refreshed);
        expectCredential(yield* Fiber.join(secondUpdate), refreshed);
        expect(secondRefreshCalls).toBe(0);
        expectCredential(yield* second.read(anthropic), refreshed);
      }),
    ));

  test("an interrupted refresh leaves the credential unchanged and releases the lock", () =>
    runInTempHome((tauDirectory) =>
      Effect.gen(function* () {
        const first = yield* openStore(tauDirectory);
        const second = yield* openStore(tauDirectory);
        yield* first.save(anthropic, expired);

        const refreshStarted = yield* Deferred.make<void>();

        const abandoned = yield* Effect.forkChild(
          first.update(anthropic, expired, () =>
            Deferred.succeed(refreshStarted, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        );

        yield* Deferred.await(refreshStarted);
        yield* Fiber.interrupt(abandoned);

        const outcome = yield* second.update(anthropic, expired, () => Effect.succeed(refreshed));
        expectCredential(outcome, refreshed);
      }),
    ));

  test("a refresh after removal returns nothing and saves nothing", () =>
    runInTempHome((tauDirectory) =>
      Effect.gen(function* () {
        const store = yield* openStore(tauDirectory);
        yield* store.save(anthropic, expired);
        yield* store.remove(anthropic);

        const outcome = yield* store.update(anthropic, expired, () => Effect.succeed(refreshed));
        expect(Option.isNone(outcome)).toBe(true);
        expect(Option.isNone(yield* store.read(anthropic))).toBe(true);
      }),
    ));

  test("only the owner can read the directory, the database and its WAL file", () =>
    runInTempHome((tauDirectory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* openStore(tauDirectory);
        yield* store.save(anthropic, expired);

        const permissions = (path: string) =>
          fileSystem.stat(path).pipe(Effect.map((stat) => stat.mode & PERMISSION_BITS));

        expect(yield* permissions(tauDirectory)).toBe(PRIVATE_DIRECTORY);
        expect(yield* permissions(`${tauDirectory}/credentials.db`)).toBe(PRIVATE_FILE);
        expect(yield* permissions(`${tauDirectory}/credentials.db-wal`)).toBe(PRIVATE_FILE);
      }),
    ));
});
