import type { Rule } from "@oxlint/plugins";
import { restrictedApiRules } from "./restricted-api.ts";
import { testRule } from "./rule-tester.ts";

const ruleNamed = (name: string): Rule => {
  const rule = restrictedApiRules[name];
  if (rule === undefined) throw new Error(`No restricted API rule named ${name}`);
  return rule;
};

const errors = (count: number) => ({ errors: count });

testRule("no-env", ruleNamed("no-env"), {
  valid: [
    "const home = settings.env.HOME;",
    "export const read = (process: { readonly env: string }) => process.env;",
    "const env = { HOME: 'x' }; export const home = env.HOME;",
  ],
  invalid: [
    { code: "export const home = process.env['HOME'];", ...errors(1) },
    { code: "export const home = process['env'];", ...errors(1) },
    { code: "export const home = Bun.env.HOME;", ...errors(1) },
    { code: "export const home = import.meta.env.HOME;", ...errors(1) },
    { code: "const proc = process; export const home = proc.env.HOME;", ...errors(1) },
    { code: "const { env } = process; export const home = env.HOME;", ...errors(1) },
    {
      code: "import { env as imported } from 'node:process'; export const read = imported;",
      ...errors(1),
    },
    {
      code: "export const home = globalThis.process.env.HOME;",
      errors: [{ message: /Read environment variables in host/ }],
    },
  ],
});

testRule("no-effect-run", ruleNamed("no-effect-run"), {
  valid: [
    "import { Effect } from 'effect'; export const task = Effect.succeed(1);",
    "const Effect = { runPromise: () => 1 }; export const result = Effect.runPromise();",
  ],
  invalid: [
    {
      code: "import { Effect } from 'effect'; export const run = () => Effect.runPromise(Effect.void);",
      ...errors(1),
    },
    {
      code: "import { Effect as Fx } from 'effect'; export const run = () => Fx.runSync(Fx.void);",
      ...errors(1),
    },
    {
      code: "import * as Effect from 'effect/Effect'; export const run = () => Effect.runFork(Effect.void);",
      ...errors(1),
    },
    {
      code: "import { runPromise } from 'effect/Effect'; export const run = runPromise;",
      ...errors(1),
    },
  ],
});

testRule("no-console", ruleNamed("no-console"), {
  valid: [
    "export const log = () => { const console = { log: (text: string) => text }; return console.log('x'); };",
    "export const log = (logger: { readonly console: string }) => logger.console;",
  ],
  invalid: [
    { code: "export const log = () => console.log('x');", ...errors(1) },
    { code: "const { log } = console; export const write = log;", ...errors(1) },
    { code: "import { Console } from 'node:console'; export const write = Console;", ...errors(1) },
  ],
});

testRule("no-fetch", ruleNamed("no-fetch"), {
  valid: [
    "export const get = (client: { fetch: () => string }) => client.fetch();",
    "const fetch = () => 1; export const get = fetch();",
  ],
  invalid: [{ code: "export const get = () => fetch('https://example.com');", ...errors(1) }],
});

testRule("no-spawn", ruleNamed("no-spawn"), {
  valid: ["const spawn = () => 1; export const start = spawn();"],
  invalid: [
    { code: "export const start = () => Bun.spawn(['true']);", ...errors(1) },
    { code: "export const start = () => Bun.spawnSync(['true']);", ...errors(1) },
    {
      code: "import { spawn } from 'node:child_process'; export const start = spawn;",
      ...errors(1),
    },
    { code: "import { spawn } from 'bun'; export const start = spawn;", ...errors(1) },
  ],
});

testRule("no-module-mock", ruleNamed("no-module-mock"), {
  valid: ["import { mock } from 'bun:test'; export const fake = mock.fn();"],
  invalid: [
    { code: "import { mock } from 'bun:test'; mock.module('node:os', () => ({}));", ...errors(1) },
    {
      code: "import { mock as replace } from 'bun:test'; replace.module('node:fs', () => ({}));",
      ...errors(1),
    },
    { code: "vi.mock('node:path', () => ({}));", ...errors(1) },
  ],
});

testRule("no-sleep", ruleNamed("no-sleep"), {
  valid: ["const sleep = () => 1; sleep();", "clock.setTimeout(() => 1, 1);"],
  invalid: [
    { code: "await Bun.sleep(1);", ...errors(1) },
    { code: "setTimeout(() => 1, 1);", ...errors(1) },
    { code: "import { setInterval } from 'node:timers'; setInterval(() => 1, 1);", ...errors(1) },
    {
      code: "import { setTimeout as wait } from 'node:timers/promises'; await wait(1);",
      ...errors(1),
    },
  ],
});

testRule("no-reflect", ruleNamed("no-reflect"), {
  valid: ["export const has = (owner: object) => Reflect.has(owner, 'name');"],
  invalid: [
    {
      code: "export const read = (owner: { name: string }) => Reflect.get(owner, 'name');",
      ...errors(1),
    },
    {
      code: "export const call = (run: () => number) => Reflect.apply(run, undefined, []);",
      ...errors(1),
    },
  ],
});

testRule("no-service-option", ruleNamed("no-service-option"), {
  valid: [
    "import { Effect } from 'effect'; export const task = Effect.service(Database);",
    "const Effect = { serviceOption: () => 1 }; export const task = Effect.serviceOption();",
  ],
  invalid: [
    {
      code: "import { Effect } from 'effect'; export const task = Effect.serviceOption(Database);",
      errors: [{ message: /optional at runtime/ }],
    },
    {
      code: "import { serviceOption } from 'effect/Effect'; export const task = serviceOption(Database);",
      errors: 1,
    },
  ],
});
