import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { type Condition, Status } from "../../src/core/Status.ts";

const now = Effect.gen(function* () {
  const status = yield* Status;
  const [conditions] = yield* Stream.runCollect(Stream.take(status.current, 1));
  return conditions;
});

const condition = (key: string, severity: Condition["severity"], text: string): Condition => ({
  key,
  severity,
  text,
});

test("conditions list errors first, keep their place when set again, and leave when cleared", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const status = yield* Status;
      yield* status.set(condition("ready", "info", "New code is ready."), "");
      yield* status.set(condition("build", "warning", "Does not build: a.ts"), "");
      yield* status.set(condition("crash", "error", "Tau crashed."), "");
      yield* status.set(condition("build", "warning", "Does not build: b.ts"), "");
      const before = yield* now;
      yield* status.clear("crash");
      const after = yield* now;

      expect(before?.map((shown) => shown.text)).toEqual([
        "Tau crashed.",
        "Does not build: b.ts",
        "New code is ready.",
      ]);

      expect(after?.map((shown) => shown.key)).toEqual(["build", "ready"]);
    }).pipe(Effect.provide(Status.layer)),
  ));
