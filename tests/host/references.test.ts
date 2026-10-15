import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, type Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import { References } from "../../src/core/References.ts";
import { TauHome } from "../../src/database/TauHome.ts";
import { referencesLayer } from "../../src/host/References.ts";
import { initRepository, shell } from "../support/git.ts";

/** Runs `use` on the references of a new Tau home, with `origin` a repository named `origin-repo`. */
const withReferences = <A, E, R>(
  use: (references: References["Service"], origin: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const home = yield* fileSystem.makeTempDirectoryScoped();
    const origin = `${yield* fileSystem.makeTempDirectoryScoped()}/origin-repo`;
    yield* fileSystem.makeDirectory(origin);
    yield* initRepository(origin, { "README.md": "one" });
    yield* shell(origin, "git branch -M main && git branch feature");

    const layer = referencesLayer.pipe(
      Layer.provide(TauHome.at(home)),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(BunServices.layer),
    );

    return yield* References.use((references) => use(references, origin)).pipe(
      Effect.provide(layer),
    );
  });

type Needs = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope;

const run = <A, E>(effect: Effect.Effect<A, E, Needs>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)));

const nothing = () => Effect.void;

describe("references", () => {
  test("the list starts empty, and a clone appears with its branch", () =>
    run(
      withReferences((references, origin) =>
        Effect.gen(function* () {
          expect(yield* references.list).toEqual([]);

          const cloned = yield* references.clone(origin, nothing);
          expect(cloned).toEqual({ name: "origin-repo", branch: "main", description: "one" });
          expect(yield* references.list).toEqual([cloned]);
        }),
      ),
    ));

  test("a second clone of the same name fails and leaves no unfinished folder", () =>
    run(
      withReferences((references, origin) =>
        Effect.gen(function* () {
          yield* references.clone(origin, nothing);
          const failure = yield* references.clone(origin, nothing).pipe(Effect.flip);
          expect(failure.message).toContain("already a reference named origin-repo");

          const names = yield* (yield* FileSystem.FileSystem).readDirectory(references.folder);
          expect(names).toEqual(["origin-repo"]);
        }),
      ),
    ));

  test("a clone of a missing repository fails with git's line and leaves nothing behind", () =>
    run(
      withReferences((references) =>
        Effect.gen(function* () {
          const failure = yield* references.clone("/no/such/repo", nothing).pipe(Effect.flip);
          expect(failure.message).toStartWith("fatal:");
          expect(yield* references.list).toEqual([]);
        }),
      ),
    ));

  test("update pulls a new commit, and switching branches changes the branch", () =>
    run(
      withReferences((references, origin) =>
        Effect.gen(function* () {
          yield* references.clone(origin, nothing);

          yield* shell(
            origin,
            "printf two > two.txt && git add -A && git -c user.name=Tau -c user.email=t@e.x -c commit.gpgsign=false commit -q -m two",
          );

          yield* references.update("origin-repo");

          const fileSystem = yield* FileSystem.FileSystem;
          expect(yield* fileSystem.exists(`${references.folder}/origin-repo/two.txt`)).toBe(true);

          expect(yield* references.branches("origin-repo")).toEqual(["feature", "main"]);

          expect(yield* references.switchBranch("origin-repo", "feature")).toEqual({
            name: "origin-repo",
            branch: "feature",
            description: "one",
          });
        }),
      ),
    ));

  test("remove deletes the folder", () =>
    run(
      withReferences((references, origin) =>
        Effect.gen(function* () {
          yield* references.clone(origin, nothing);
          yield* references.remove("origin-repo");
          expect(yield* references.list).toEqual([]);
        }),
      ),
    ));
});
