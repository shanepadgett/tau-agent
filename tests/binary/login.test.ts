import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ApiKey, CredentialStore, ProviderId } from "../../src/ai/Credential.ts";
import { builtInRoutes } from "../../src/ai/Routes.ts";
import { TauHome } from "../../src/database/TauHome.ts";
import { credentialStoreLayer } from "../../src/host/CredentialStore.ts";

// Builds the binary, so it takes seconds and runs before commit, not after each agent run.
const BUILD_AND_RUN_MILLIS = 60_000;

const DOWN = "\u001B[B";
const ENTER = "\r";

const openai = ProviderId.make("openai");

/** What to type once `prompt` shows. */
type Answer = { readonly prompt: string; readonly keys: string };

const buildTau = Effect.fn("buildTau")(function* (directory: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const binary = join(directory, "tau");

  const build = ChildProcess.make("bun", [
    "build",
    "--compile",
    "src/cli/main.ts",
    "--outfile",
    binary,
  ]);

  expect(yield* spawner.exitCode(build)).toBe(ChildProcessSpawner.ExitCode(0));
  return binary;
});

/** Runs the compiled `tau` with `home` as the user's home, typing each answer once its prompt shows. */
const runTau = Effect.fn("runTau")(function* (
  binary: string,
  home: string,
  command: string,
  answers: ReadonlyArray<Answer>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const keys = yield* Queue.unbounded<Uint8Array>();

  const child = yield* spawner.spawn(
    ChildProcess.make(binary, [command], {
      env: { HOME: home },
      extendEnv: true,
      stdin: Stream.fromQueue(keys),
    }),
  );

  let output = "";
  let answered = 0;
  let searchFrom = 0;

  yield* child.all.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => {
      output += chunk;
      const answer = answers[answered];
      const shownAt = answer === undefined ? -1 : output.indexOf(answer.prompt, searchFrom);
      if (answer === undefined || shownAt === -1) return Effect.void;

      answered += 1;
      searchFrom = shownAt + answer.prompt.length;
      return Queue.offer(keys, new TextEncoder().encode(answer.keys));
    }),
  );

  return { exitCode: yield* child.exitCode, output };
});

const readSaved = Effect.fn("readSaved")(function* (home: string) {
  const services = yield* Layer.build(
    credentialStoreLayer.pipe(Layer.provide(TauHome.at(join(home, ".tau")))),
  );

  return yield* Context.get(services, CredentialStore).read(openai);
});

const openaiChoice = DOWN.repeat(builtInRoutes.findIndex((route) => route.provider === openai));

describe("compiled tau", () => {
  test(
    "logs in with an API key and logs out again",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const binary = yield* buildTau(yield* fs.makeTempDirectoryScoped());
        const home = yield* fs.makeTempDirectoryScoped();

        const login = yield* runTau(binary, home, "login", [
          { prompt: "Log in to", keys: `${openaiChoice}${ENTER}` },
          { prompt: "openai API key", keys: `sk-binary-test${ENTER}` },
        ]);

        expect(login.output).toContain("Logged in to openai.");
        expect(login.exitCode).toBe(ChildProcessSpawner.ExitCode(0));

        const saved = Option.filter(yield* readSaved(home), Schema.is(ApiKey));

        expect(Option.map(saved, (key) => Redacted.value(key.key))).toEqual(
          Option.some("sk-binary-test"),
        );

        const logout = yield* runTau(binary, home, "logout", [
          { prompt: "Log out of", keys: ENTER },
        ]);

        expect(logout.output).toContain("Logged out of openai.");
        expect(yield* readSaved(home)).toEqual(Option.none());
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise),
    BUILD_AND_RUN_MILLIS,
  );
});
