import { expect, test } from "bun:test";
import { createWorkspace, type Files } from "./workspace.ts";

const FILE_COUNT = 200;

/** Bounded Effect-heavy modules, generated only inside the temporary workspace. */
const project: Files = {
  "src/ai/message.ts": "export type Message = { readonly text: string; readonly index: number };\n",
  ...Object.fromEntries(
    Array.from({ length: FILE_COUNT }, (_, index) => [
      `src/core/reply-${index}.ts`,
      `import { Effect } from "effect";
import type { Message } from "../ai/message.ts";

export const reply = Effect.fn("reply-${index}")(function* (text: string) {
  const message = yield* Effect.succeed(text.trim());
  const response: Message = { text: message, index: ${index} };
  return response;
});
`,
    ]),
  ),
};

test("records separate type and lint peak memory on a bounded Effect fixture", async () => {
  await using workspace = await createWorkspace(project);

  for (const name of ["check:types", "check:lint"]) {
    const started = performance.now();
    const result = await workspace.run(["mise", "run", name]);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.maxRSS).toBeGreaterThan(0);

    console.log(
      `${process.platform}/${process.arch} ${name}: ${FILE_COUNT} Effect modules, peak ${(result.maxRSS / 1024 ** 2).toFixed(1)} MiB, ${(performance.now() - started).toFixed(0)} ms`,
    );
  }
}, 60_000);
