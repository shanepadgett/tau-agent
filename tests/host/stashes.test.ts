import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { DateTime, Effect, FileSystem, Layer, Scope } from "effect";
import { Stashes } from "../../src/core/Stashes.ts";
import { TauHome } from "../../src/database/TauHome.ts";
import { stashesLayer } from "../../src/host/Stashes.ts";

/** Runs `use` on the stashes of a new Tau home. */
const withStashes = <A, E>(use: (stashes: Stashes["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();

    const layer = stashesLayer.pipe(
      Layer.provide(TauHome.at(home)),
      Layer.provide(BunServices.layer),
    );

    return yield* Stashes.use(use).pipe(Effect.provide(layer));
  });

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)));

describe("stashes", () => {
  test("a project starts empty, and its stashes list the latest first", () =>
    run(
      withStashes((stashes) =>
        Effect.gen(function* () {
          expect(yield* stashes.list("/work/a")).toEqual([]);
          expect(yield* stashes.add("/work/a", "first")).toBe("stashed");
          yield* Effect.sleep("2 millis");
          expect(yield* stashes.add("/work/a", "second")).toBe("stashed");

          const listed = yield* stashes.list("/work/a");
          expect(listed.map((stash) => stash.text)).toEqual(["second", "first"]);
          expect(DateTime.isDateTime(listed[0]?.createdAt)).toBe(true);
        }),
      ),
    ));

  test("the same text in the same project is a duplicate, and in another project it is not", () =>
    run(
      withStashes((stashes) =>
        Effect.gen(function* () {
          yield* stashes.add("/work/a", "draft");
          expect(yield* stashes.add("/work/a", "draft")).toBe("duplicate");
          expect(yield* stashes.add("/work/b", "draft")).toBe("stashed");
          expect(yield* stashes.list("/work/a")).toHaveLength(1);
          expect(yield* stashes.list("/work/b")).toHaveLength(1);
        }),
      ),
    ));

  test("removing a stash leaves the others, and the text can be stashed again", () =>
    run(
      withStashes((stashes) =>
        Effect.gen(function* () {
          yield* stashes.add("/work/a", "one");
          yield* stashes.add("/work/a", "two");
          const [latest] = yield* stashes.list("/work/a");
          if (latest === undefined) throw new Error("no stash");

          yield* stashes.remove(latest.id);
          expect((yield* stashes.list("/work/a")).map((stash) => stash.text)).toEqual(["one"]);
          expect(yield* stashes.add("/work/a", "two")).toBe("stashed");
        }),
      ),
    ));
});
