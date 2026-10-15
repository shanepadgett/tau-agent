import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Context, Effect, FileSystem, Layer, Schedule, type Scope } from "effect";
import { FileIndex, type Search } from "../../src/workspace/FileIndex.ts";
import { shell } from "../support/git.ts";

type Services = Scope.Scope | FileSystem.FileSystem | BunServices.BunServices;

/** Runs `program` with an index whose databases are in a temp folder, and a temp folder of `files`. */
const withIndex = <A, E>(
  files: Readonly<Record<string, string>>,
  program: (index: FileIndex["Service"], folder: string) => Effect.Effect<A, E, Services>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const folder = yield* fileSystem.makeTempDirectoryScoped();
      const databases = yield* fileSystem.makeTempDirectoryScoped();

      for (const [path, text] of Object.entries(files)) {
        yield* fileSystem.makeDirectory(dirname(join(folder, path)), { recursive: true });
        yield* fileSystem.writeFileString(join(folder, path), text);
      }

      const context = yield* Layer.build(FileIndex.at(databases));
      return yield* program(Context.get(context, FileIndex), folder);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

/** The paths found once the search shows what `isDone` waits for; FFF scans and watches in the background. */
const pathsWhen = (
  index: FileIndex["Service"],
  folder: string,
  query: string,
  isDone: (paths: readonly string[]) => boolean,
) =>
  index.search(folder, query, 20).pipe(
    Effect.map((search: Search) =>
      search.state === "ready" ? search.found.map((found) => found.path) : [],
    ),
    Effect.repeat({ until: isDone, schedule: Schedule.spaced("50 millis") }),
    Effect.timeout("10 seconds"),
  );

describe("file index", () => {
  test("finds files and folders by a fuzzy query, typos included", () =>
    withIndex({ "src/tui/Input.tsx": "", "README.md": "" }, (index, folder) =>
      Effect.gen(function* () {
        const all = yield* pathsWhen(index, folder, "", (paths) => paths.length === 4);
        expect([...all].sort()).toEqual(["README.md", "src/", "src/tui/", "src/tui/Input.tsx"]);

        const typo = yield* pathsWhen(index, folder, "inpt", (paths) => paths.length > 0);
        expect(typo[0]).toBe("src/tui/Input.tsx");
      }),
    ));

  test("follows files that are created, renamed and deleted", () =>
    withIndex({ "a.txt": "" }, (index, folder) =>
      Effect.gen(function* () {
        yield* pathsWhen(index, folder, "", (paths) => paths.includes("a.txt"));

        yield* shell(folder, "echo b > new.txt");
        yield* pathsWhen(index, folder, "", (paths) => paths.includes("new.txt"));

        yield* shell(folder, "mv new.txt renamed.txt && rm a.txt");

        const after = yield* pathsWhen(
          index,
          folder,
          "",
          (paths) => paths.includes("renamed.txt") && !paths.includes("a.txt"),
        );

        expect(after).not.toContain("new.txt");
      }),
    ));

  test("is off in the home folder and at the file system root", () =>
    withIndex({}, (index) =>
      Effect.gen(function* () {
        expect(yield* index.search(homedir(), "", 20)).toEqual({ state: "off", reason: "home" });
        expect(yield* index.search("/", "", 20)).toEqual({ state: "off", reason: "root" });
      }),
    ));
});
