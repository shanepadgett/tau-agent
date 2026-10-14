import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Option, type Scope } from "effect";
import { repositoryRoot } from "../../src/workspace/Repository.ts";
import { changedFiles, snapshot } from "../../src/workspace/Snapshot.ts";
import { initRepository, shell } from "../support/git.ts";

type Services = Scope.Scope | FileSystem.FileSystem | BunServices.BunServices;

/** Runs `program` with a new temp folder that is a repository with one commit of `files`. */
const withRepository = <A, E>(
  files: Readonly<Record<string, string>>,
  program: (root: string) => Effect.Effect<A, E, Services>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* initRepository(directory, files);
      return yield* program(directory);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

/** The files that differ in the repository after `change` runs in it. */
const changedBy = (root: string, change: string) =>
  Effect.gen(function* () {
    const before = yield* snapshot(root);
    yield* shell(root, change);
    return changedFiles(before, yield* snapshot(root));
  });

describe("snapshots", () => {
  test("a change made by any command is found: edited, new and deleted files", () =>
    withRepository({ "a.txt": "a", "b.txt": "b", "src/c.txt": "c" }, (root) =>
      Effect.gen(function* () {
        const changed = yield* changedBy(
          root,
          "echo more >> a.txt && rm b.txt && mkdir -p new && echo d > new/d.txt",
        );

        expect(changed).toEqual(["a.txt", "b.txt", "new/d.txt"]);
      }),
    ));

  test("a file that was already changed before is found when it changes again", () =>
    withRepository({ "a.txt": "a" }, (root) =>
      Effect.gen(function* () {
        yield* shell(root, "echo first >> a.txt && echo new > new.txt");
        const changed = yield* changedBy(root, "echo second >> a.txt");
        expect(changed).toEqual(["a.txt"]);
      }),
    ));

  test("a file changed and changed back is not a change", () =>
    withRepository({ "a.txt": "a" }, (root) =>
      Effect.gen(function* () {
        const changed = yield* changedBy(root, "echo more >> a.txt && git checkout -q a.txt");
        expect(changed).toEqual([]);
      }),
    ));

  test("a renamed file is found at both paths", () =>
    withRepository({ "a.txt": "a" }, (root) =>
      Effect.gen(function* () {
        const changed = yield* changedBy(root, "git mv a.txt b.txt");
        expect(changed).toEqual(["a.txt", "b.txt"]);
      }),
    ));

  test("a folder in a repository has the repository's root, and a folder outside has none", () =>
    withRepository({ "src/a.txt": "a" }, (root) =>
      Effect.gen(function* () {
        const realRoot = (yield* shell(root, "pwd -P")).trim();
        expect(yield* repositoryRoot(`${root}/src`)).toEqual(Option.some(realRoot));

        const fileSystem = yield* FileSystem.FileSystem;
        const outside = yield* fileSystem.makeTempDirectoryScoped();
        expect(yield* repositoryRoot(outside)).toEqual(Option.none());
      }),
    ));
});
