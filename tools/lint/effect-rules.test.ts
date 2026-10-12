import { noSilentErrorSwallow, noYieldlessGen, preferEffectFn } from "./effect-rules.ts";
import { testRule } from "./rule-tester.ts";

const EFFECT = "import { Effect } from 'effect';\n";

testRule("no-silent-error-swallow", noSilentErrorSwallow, {
  valid: [
    EFFECT +
      "export const safe = (task: Effect.Effect<number, string>) => task.pipe(Effect.catch((error) => Effect.logError(error)));",
    EFFECT +
      "export const safe = (task: Effect.Effect<number, string>) => task.pipe(Effect.catch((error) => Effect.succeed(error.length)));",
    EFFECT +
      "export const safe = (task: Effect.Effect<number, string>) => task.pipe(Effect.catch((error) => { console.log(error); return Effect.void; }));",
    EFFECT +
      "export const safe = (task: Effect.Effect<number, string>) => task.pipe(Effect.ignore);",
    EFFECT +
      "export const safe = (task: Effect.Effect<number, string>) => task.pipe(Effect.catch(() => Effect.succeed(0)));",
    EFFECT +
      "export const safe = (task: Effect.Effect<number, string>) => task.pipe(Effect.catchIf((error) => error === 'x', (error) => Effect.fail(error)));",
    "const Effect = { catch: (handler: () => unknown) => handler }; export const safe = Effect.catch(() => undefined);",
  ],
  invalid: [
    {
      code:
        EFFECT +
        "export const swallowed = (task: Effect.Effect<number, string>) => task.pipe(Effect.catch(() => Effect.void));",
      errors: [{ message: /discards the error/, line: 2 }],
    },
    {
      code:
        EFFECT +
        "export const swallowed = (task: Effect.Effect<number, string>) => task.pipe(Effect.catch((_error) => Effect.void));",
      errors: 1,
    },
    {
      code:
        EFFECT +
        "export const swallowed = (task: Effect.Effect<number, string>) => task.pipe(Effect.catch(() => Effect.succeed(undefined)));",
      errors: 1,
    },
    {
      code:
        EFFECT +
        "export const swallowed = (task: Effect.Effect<number, string>) => task.pipe(Effect.catchCause(function () { return Effect.succeed(); }));",
      errors: 1,
    },
    {
      code:
        EFFECT +
        "export const swallowed = (task: Effect.Effect<number, string>) => task.pipe(Effect.orElseSucceed(() => undefined));",
      errors: 1,
    },
    {
      code: "import * as Fx from 'effect/Effect'; export const swallowed = (task: Fx.Effect<number, string>) => Fx.catch(task, () => Fx.void);",
      errors: 1,
    },
    {
      code:
        EFFECT +
        "export const swallowed = (task: Effect.Effect<number, string>) => task.pipe(Effect.catchIf((error) => error === 'x', () => Effect.void));",
      errors: 1,
    },
  ],
});

testRule("no-yieldless-gen", noYieldlessGen, {
  valid: [
    EFFECT +
      "export const task = Effect.gen(function* () { const value = yield* Effect.succeed(1); return value; });",
    EFFECT + "export const task = Effect.gen(function* () { yield* Effect.log('x'); });",
    EFFECT +
      "export const task = Effect.gen(function* () { const inner = () => 1; return yield* Effect.sync(inner); });",
    "function* numbers() { return 1; } export const list = numbers();",
    "const Effect = { gen: (body: () => unknown) => body }; export const task = Effect.gen(function* () { return 1; });",
  ],
  invalid: [
    {
      code: EFFECT + "export const task = Effect.gen(function* () { return 1; });",
      errors: [{ message: /never yields/, line: 2 }],
    },
    {
      code:
        EFFECT +
        "export const task = Effect.gen(function* () { const value = 1; return value + 1; });",
      errors: 1,
    },
    {
      code:
        EFFECT +
        "export const task = Effect.gen(function* () { const run = function* () { yield 1; }; return run; });",
      errors: 1,
    },
    {
      code: "import * as Fx from 'effect/Effect'; export const task = Fx.gen(function* () { return 1; });",
      errors: 1,
    },
  ],
});

testRule("prefer-effect-fn", preferEffectFn, {
  valid: [
    EFFECT + "export const read = Effect.gen(function* () { return yield* Effect.succeed(1); });",
    EFFECT +
      "export const read = () => Effect.gen(function* () { return yield* Effect.succeed(1); });",
    EFFECT +
      "export const read = Effect.fn('read')(function* (start: number) { return yield* Effect.succeed(start); });",
    EFFECT +
      "export const read = (start: number) => Effect.succeed(start).pipe(Effect.map((value) => value + 1));",
    EFFECT +
      "export const read = (start: number) => { const next = start + 1; return Effect.gen(function* () { return yield* Effect.succeed(next); }); };",
    "const Effect = { gen: (body: () => unknown) => body }; export const read = (start: number) => Effect.gen(function* () { return start; });",
  ],
  invalid: [
    {
      code:
        EFFECT +
        "export const read = (start: number) => Effect.gen(function* () { return yield* Effect.succeed(start); });",
      errors: [{ message: /Effect\.fn/, line: 2 }],
    },
    {
      code:
        EFFECT +
        "export function read(start: number) { return Effect.gen(function* () { return yield* Effect.succeed(start); }); }",
      errors: 1,
    },
  ],
});
