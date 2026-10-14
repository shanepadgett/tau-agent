import { describe, expect, test } from "bun:test";
import { CodeMode, Tool } from "@opencode/codemode";
import { Effect, Exit, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";

const execute = (code: string, maxOutputBytes: number) =>
  Effect.runPromise(CodeMode.execute({ code, limits: { maxOutputBytes } }));

describe("script console capture", () => {
  test("keeps a prefix and counts every attempted entry after capture closes", async () => {
    const result = await execute(
      'for (let index = 0; index < 200; index++) console.log("line"); return 7;',
      32,
    );

    expect(result).toMatchObject({ ok: true, value: 7, truncated: true });

    expect(result.logs).toEqual([
      ...Array<string>(6).fill("line"),
      "[logs truncated: showing 6 of 200 lines]",
    ]);
  });

  test("charges empty lines against the capture budget", async () => {
    const result = await execute("for (let index = 0; index < 40; index++) console.log();", 8);

    expect(result.logs).toEqual(["", "", "", "", "[logs truncated: showing 4 of 40 lines]"]);
    expect(result.truncated).toBe(true);
  });

  test("retains one large string that fits exactly with its newline and return value", async () => {
    const size = 128 * 1024;
    const result = await execute(`console.log("x".repeat(${size})); return 0;`, size + 2);
    expect(result.logs).toEqual(["x".repeat(size)]);
    expect(result.truncated).toBeUndefined();
  });

  test("counts Unicode bytes and preserves embedded newlines", async () => {
    const unicode = await execute('console.log("💩é"); console.log("x"); return 0;', 8);
    expect(unicode.logs).toEqual(["💩é", "[logs truncated: showing 1 of 2 lines]"]);

    const multiline = await execute('console.log("a\\nb"); console.log("x"); return 0;', 8);
    expect(multiline.logs).toEqual(["a\nb", "x"]);
    expect(multiline.truncated).toBeUndefined();
  });

  test("stops after the first non-fitting entry and reserves the final value's budget", async () => {
    const result = await execute(
      'console.log("before"); console.log("x".repeat(100)); console.log("after"); return "r".repeat(60);',
      64,
    );

    expect(result).toMatchObject({ ok: true, value: "r".repeat(60), truncated: true });
    expect(result.logs).toEqual(["[logs truncated: showing 0 of 3 lines]"]);
  });

  test.each([
    "console.log(Array(10000).fill(value));",
    "console.dir({ huge: Array(10000).fill(value) });",
    'console.log(new Map([["huge", Array(10000).fill(value)]]));',
    "console.log(new Set([Array(10000).fill(value)]));",
    "console.log(new Uint8Array(100000));",
    "console.table(Array(1000).fill({ text: value }));",
    'console.table(Array(1000).fill({ text: "x" }), Array(1000).fill("text"));',
    'console.table(Array.from({ length: 100 }, (_, index) => ({ ["column" + index]: "x" })));',
    "console.log(new Error(value));",
    'console.log(new URLSearchParams({ text: "💩".repeat(10000) }));',
    "console.log(new Headers({ text: value }));",
  ])("skips oversized formatting and still calls tools: %s", (print) =>
    Effect.gen(function* () {
      let called = false;

      const result = yield* CodeMode.execute({
        code: `const value = "x".repeat(1024 * 1024); ${print} return await tools.finish({});`,
        limits: { maxOutputBytes: 64 },
        tools: {
          finish: Tool.make({
            description: "Records that the script continued.",
            input: Schema.Struct({}),
            output: Schema.String,
            execute: () =>
              Effect.sync(() => {
                called = true;
                return "done";
              }),
          }),
        },
      });

      expect(called).toBe(true);
      expect(result).toMatchObject({ ok: true, value: "done", truncated: true });
      expect(result.logs).toEqual(["[logs truncated: showing 0 of 1 lines]"]);
      expect(result.toolCalls).toEqual([{ name: "finish" }]);
    }).pipe(Effect.runPromise),
  );

  test("preserves ordinary collection, cycle and table formatting", async () => {
    const result = await execute(
      [
        'const circular = new Map(); circular.set("self", circular);',
        'console.log({ map: circular, set: new Set([2]), bytes: new Uint8Array([1, 2]), headers: new Headers({ x: "y" }) });',
        'console.table([{ a: 1, b: "hi" }, { a: 2 }]);',
      ].join("\n"),
      65536,
    );

    expect(result.truncated).toBeUndefined();

    expect(result.logs).toEqual([
      '{"map":Map(1) [["self",[Circular]]],"set":Set(1) [2],"bytes":Uint8Array(2) [1,2],"headers":Headers {"x":"y"}}',
      "(index)\ta\tb\n0\t1\thi\n1\t2\t",
    ]);
  });

  test("retains logs and truncation after a script failure", async () => {
    const result = await execute(
      'console.warn("before"); console.log("x".repeat(1000)); throw new Error("broken");',
      64,
    );

    expect(result).toMatchObject({
      ok: false,
      truncated: true,
      error: { message: "Error: broken" },
    });

    expect(result.logs).toEqual(["[warn] before", "[logs truncated: showing 1 of 2 lines]"]);
  });

  test.each(["timeout", "cancel"])(
    "cleans up pending tools after output truncation: %s",
    (ending) =>
      Effect.gen(function* () {
        let cleaned = false;

        const pending = yield* Effect.forkChild(
          CodeMode.execute({
            code: 'console.log("before"); console.log("x".repeat(1000)); await tools.wait({});',
            limits: { maxOutputBytes: 64, timeoutMs: 1000 },
            tools: {
              wait: Tool.make({
                description: "Waits until the script is stopped.",
                input: Schema.Struct({}),
                execute: () =>
                  Effect.never.pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        cleaned = true;
                      }),
                    ),
                  ),
              }),
            },
          }),
        );

        yield* TestClock.adjust(ending === "timeout" ? "1 second" : "0 seconds");
        if (ending === "cancel") yield* Fiber.interrupt(pending);
        const exit = yield* Fiber.await(pending);
        expect(cleaned).toBe(true);

        if (ending === "cancel") expect(Exit.isFailure(exit)).toBe(true);
        else {
          if (Exit.isFailure(exit)) throw new Error("Expected a timeout result");

          expect(exit.value).toMatchObject({
            ok: false,
            truncated: true,
            error: { kind: "TimeoutExceeded" },
          });

          expect(exit.value.logs).toEqual(["before", "[logs truncated: showing 1 of 2 lines]"]);
        }
      }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise),
  );

  test("starts fresh on each execution and preserves no-limit behavior", async () => {
    const runtime = CodeMode.make({ limits: { maxOutputBytes: 16 } });
    const first = await Effect.runPromise(runtime.execute('console.log("x".repeat(100));'));
    const second = await Effect.runPromise(runtime.execute('console.log("next");'));
    expect(first.truncated).toBe(true);
    expect(second.logs).toEqual(["next"]);
    expect(second.truncated).toBeUndefined();

    const unlimited = await Effect.runPromise(
      CodeMode.execute({
        code: 'for (let index = 0; index < 100; index++) console.log("line");',
      }),
    );

    expect(unlimited.logs).toHaveLength(100);
    expect(unlimited.truncated).toBeUndefined();
  });

  test("caps empty-entry metadata even with a large byte budget", async () => {
    const result = await execute(
      "for (let index = 0; index < 65540; index++) console.log(); return 0;",
      10 * 1024 * 1024,
    );

    expect(result).toMatchObject({ ok: true, value: 0, truncated: true });
    expect(result.logs).toHaveLength(65537);
    expect(result.logs?.[65535]).toBe("");
    expect(result.logs?.[65536]).toBe("[logs truncated: showing 65536 of 65540 lines]");
  });
});
