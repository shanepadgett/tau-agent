import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Option, type Scope } from "effect";
import { changedFiles, commitFiles, pushTarget, recentSubjects } from "../../src/workspace/Git.ts";
import { initRepository, shell } from "../support/git.ts";

type Services = Scope.Scope | FileSystem.FileSystem | BunServices.BunServices;

/** Runs `program` in a new repository with one commit of `files`, and a local committer. */
const withRepository = <A, E>(
  files: Readonly<Record<string, string>>,
  program: (root: string) => Effect.Effect<A, E, Services>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* initRepository(directory, files);

      yield* shell(
        directory,
        "git config user.name Tau && git config user.email tau@example.com && git config commit.gpgsign false",
      );

      return yield* program(directory);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

describe("git for /commit", () => {
  test("changed files list edits, new files, deletions and renames", () =>
    withRepository({ "a.txt": "a", "b.txt": "b", "old.txt": "same text" }, (root) =>
      Effect.gen(function* () {
        yield* shell(
          root,
          "echo more >> a.txt && rm b.txt && echo new > 'new file.txt' && git mv old.txt moved.txt",
        );

        const files = yield* changedFiles(root);

        expect(
          files
            .map(({ path, previousPath }) => [path, previousPath])
            .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
        ).toEqual([
          ["a.txt", undefined],
          ["b.txt", undefined],
          ["moved.txt", "old.txt"],
          ["new file.txt", undefined],
        ]);
      }),
    ));

  test("each commit holds only its files, even when other files were staged", () =>
    withRepository({ "a.txt": "a", "b.txt": "b" }, (root) =>
      Effect.gen(function* () {
        yield* shell(root, "echo more >> a.txt && echo more >> b.txt && git add b.txt");
        const hash = yield* commitFiles(root, ["a.txt"], "fix: change a");

        expect(hash).toMatch(/^[0-9a-f]{7,}$/u);
        expect(yield* recentSubjects(root, 2)).toEqual(["fix: change a", "start"]);
        expect((yield* changedFiles(root)).map(({ path }) => path)).toEqual(["b.txt"]);
      }),
    ));

  test("a branch with no upstream pushes to a new origin branch", () =>
    withRepository({ "a.txt": "a" }, (root) =>
      Effect.gen(function* () {
        yield* shell(root, "git checkout -q -b work");
        const target = yield* pushTarget(root);

        expect(Option.getOrUndefined(target)).toEqual({
          name: "origin/work",
          isNew: true,
          branch: "work",
        });
      }),
    ));
});
