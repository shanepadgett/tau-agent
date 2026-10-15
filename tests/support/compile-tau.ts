/** Compiles Tau into one binary, as a release would, for tests that run the binary. */

import { expect } from "bun:test";
import { join } from "node:path";
import solidPlugin from "@opentui/solid/bun-plugin";
import { Effect } from "effect";

export const compileTau = Effect.fn("compileTau")(function* (directory: string) {
  const binary = join(directory, "tau");

  const built = yield* Effect.promise(() =>
    Bun.build({
      entrypoints: ["src/cli/main.ts"],
      target: "bun",
      // The TUI's .tsx files need Solid's transform; the `bun build` command line cannot add it.
      plugins: [solidPlugin],
      // Without this, the binary reads the `bunfig.toml` of the folder it runs in, and fails on
      // this repository's preload, which only Bun running from source can resolve.
      compile: { outfile: binary, autoloadBunfig: false },
      throw: false,
    }),
  );

  expect(built.logs.map((log) => log.message)).toEqual([]);
  expect(built.success).toBe(true);
  return binary;
});
