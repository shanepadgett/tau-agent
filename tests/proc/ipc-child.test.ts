import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { spawnIpcChild } from "../../src/proc/IpcChild.ts";

/** A Bun program that answers each message, then exits with the code it gets. */
const ECHO = `
process.on("message", (message) => {
  console.log("out");
  console.error("error: " + message.text);
  process.send({ echo: message.text }, undefined, undefined, () => process.exit(message.code));
});
`;

describe("a program on Bun IPC", () => {
  test("gets messages, answers, and reports its exit and its output", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const child = yield* spawnIpcChild<{ text: string; code: number }>(
          [process.execPath, "-e", ECHO],
          "captured",
        );

        yield* child.send({ text: "hi", code: 3 });
        const messages = yield* Stream.runCollect(child.messages);
        const exit = yield* child.exited;

        expect(messages).toEqual([{ echo: "hi" }]);
        expect(exit.code).toBe(3);
        expect(exit.output).toContain("error: hi");
      }).pipe(Effect.scoped),
    ));
});
