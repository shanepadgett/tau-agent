/**
 * The versions of Tau that the supervisor can run. From source, each change in `src/` can give a
 * new build; a released binary has one build, itself.
 */

import { join } from "node:path";
import { Context, Duration, Effect, FileSystem, Layer, Ref, Schema, Stream } from "effect";

/** A version of Tau: the command that starts it, before Tau's own arguments. */
export type Build = { readonly id: number; readonly command: readonly string[] };

class BuildFailed extends Schema.TaggedError<BuildFailed>()("BuildFailed", {
  reason: Schema.String,
}) {}

/** Waits this long after a change in `src/`, because one save often changes several files. */
const SETTLE_MILLIS = 100;
const SETTLE_TIME = Duration.millis(SETTLE_MILLIS);

/** OpenTUI imports the native package of every platform; a bundle can resolve only the installed one. */
const PLATFORMS = [
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-x64-musl",
  "linux-arm64",
  "linux-arm64-musl",
  "win32-x64",
  "win32-arm64",
];

export class Builds extends Context.Service<
  Builds,
  {
    /** The build the supervisor starts with. */
    readonly first: Effect.Effect<Build, BuildFailed>;
    /** Emits when Tau's code changed, so a new build can differ. */
    readonly changes: Stream.Stream<FileSystem.WatchEvent>;
    readonly build: Effect.Effect<Build, BuildFailed>;
    /** Deletes every build except `keep`. */
    readonly prune: (keep: readonly Build[]) => Effect.Effect<void>;
  }
>()("tau/supervisor/Builds") {
  /** The running binary. It never changes, so it never rebuilds. */
  static readonly binary = Layer.succeed(Builds, {
    first: Effect.succeed({ id: 0, command: [process.execPath] }),
    changes: Stream.never,
    build: Effect.fail(new BuildFailed({ reason: "A released Tau does not rebuild itself." })),
    prune: () => Effect.void,
  });

  /**
   * Bundles of Tau's source in the repository at `root`, in a temporary folder that is deleted
   * when the supervisor stops. Each runs with `bun --config` set to an empty file, so the
   * `bunfig.toml` of the folder Tau works in does not apply to Tau.
   */
  static readonly fromSource = (root: string) =>
    Layer.effect(
      Builds,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const folder = yield* fs.makeTempDirectoryScoped({ prefix: "tau-builds-" });
        const lastId = yield* Ref.make(0);

        const build = Effect.gen(function* () {
          const id = yield* Ref.updateAndGet(lastId, (last) => last + 1);
          const outdir = join(folder, String(id));
          yield* bundle(join(root, "src", "cli", "main.ts"), outdir);
          const config = join(outdir, "bunfig.toml");
          yield* fs.writeFileString(config, "").pipe(Effect.orDie);
          return { id, command: [process.execPath, `--config=${config}`, join(outdir, "main.js")] };
        });

        const prune = (keep: readonly Build[]) =>
          Effect.gen(function* () {
            const kept = new Set(keep.map((kept) => String(kept.id)));

            for (const name of yield* fs.readDirectory(folder)) {
              if (!kept.has(name)) yield* fs.remove(join(folder, name), { recursive: true });
            }
          }).pipe(Effect.ignore);

        return {
          first: build,
          changes: fs
            .watch(join(root, "src"), { recursive: true })
            .pipe(Stream.debounce(SETTLE_TIME), Stream.ignore),
          build,
          prune,
        };
      }),
    );
}

/**
 * Bundles `entry` into `outdir`. `publicPath` is the absolute folder, so OpenTUI's native library
 * loads from any current folder.
 */
const bundle = Effect.fn("bundle")(function* (entry: string, outdir: string) {
  const { default: solidPlugin } = yield* Effect.promise(() => import("@opentui/solid/bun-plugin"));
  const installed = `${process.platform}-${process.arch}`;

  const built = yield* Effect.promise(() =>
    Bun.build({
      entrypoints: [entry],
      outdir,
      target: "bun",
      plugins: [solidPlugin],
      external: PLATFORMS.flatMap((name) => (name === installed ? [] : [`@opentui/core-${name}`])),
      publicPath: `${outdir}/`,
      throw: false,
    }),
  );

  // The first error is the cause; the rest often follow from it.
  const [firstLog] = built.logs;

  if (!built.success) {
    return yield* new BuildFailed({ reason: firstLog?.message ?? "Bun did not say why." });
  }
});
