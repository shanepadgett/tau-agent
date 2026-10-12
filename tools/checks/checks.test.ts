import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCase, task, TIMEOUT, type Case } from "./check-case.ts";
import {
  createWorkspace,
  documented,
  type Files,
  type Workspace,
  type WorkspaceOptions,
} from "./workspace.ts";

const MANIFEST: {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
} = await Bun.file(new URL("../../package.json", import.meta.url)).json();

/** Formats the generated manifest and copies the docs the reference check expects. */
const syncReference = async (workspace: Workspace) => {
  for (const command of [task("fix:fmt", "docs/reference/sources.json"), task("docs")]) {
    expect((await workspace.run(command)).exitCode).toBe(0);
  }
};

/** Ignores every pin, so the full check needs no copied docs beyond the generated index. */
const REFERENCE: Files = {
  "docs/reference/sources.json": JSON.stringify({
    ignore: [
      ...Object.keys(MANIFEST.dependencies),
      ...Object.keys(MANIFEST.devDependencies),
      "bun",
      "node",
    ],
    sources: [],
  }),
};

/** Entries the scaffold adds when cli and sdk exist. */
const ENTRIES: WorkspaceOptions = {
  package: { bin: { tau: "src/cli/main.ts" }, exports: { ".": "./src/sdk/index.ts" } },
};

/** A small project with every layer, every allowed import edge and one test. */
const PROJECT: Files = documented({
  "src/ai/model.ts": `export type Message = { readonly text: string };

export const model = (text: string): Message => ({ text });
`,
  "src/workspace/snapshot.ts": `export const snapshot = () => "clean";
`,
  "src/proc/spawn.ts": `export const spawn = (command: readonly string[]) => Bun.spawn([...command]);
`,
  "src/sandbox/script.ts": `export const evaluate = (source: string) => source.length;
`,
  "src/database/connection.ts": `import { Database } from "bun:sqlite";

export const openMemory = () => {
  const database = new Database(":memory:");
  database.close();
  return ":memory:";
};
`,
  "src/session/store.ts": `import { model, type Message } from "../ai/model.ts";
import { openMemory } from "../database/connection.ts";

export const remember = (text: string): Message => model(\`\${text} \${openMemory()}\`);
`,
  "src/core/agent.ts": `import { Context, Effect, Layer } from "effect";
import type { Message } from "../ai/model.ts";
import { spawn } from "../proc/spawn.ts";
import { evaluate } from "../sandbox/script.ts";
import { remember } from "../session/store.ts";
import { snapshot } from "../workspace/snapshot.ts";

export class Agent extends Context.Service<
  Agent,
  { readonly reply: (text: string) => Effect.Effect<Message> }
>()("Agent") {}

export const AgentLive = Layer.succeed(Agent, {
  reply: (text) => Effect.succeed(remember(\`\${text} \${snapshot()} \${evaluate(text)}\`)),
});

export const start = () => spawn(["true"]);
`,
  "src/sdk/index.ts": `import { Effect } from "effect";
import { model } from "../ai/model.ts";
import { Agent } from "../core/agent.ts";

export const reply = Effect.fn("reply")(function* (text: string) {
  const agent = yield* Agent;
  return yield* agent.reply(model(text).text);
});

/** Public API with no internal caller. */
export const version = "0.0.0";
`,
  "src/host/settings.ts": `import { model } from "../ai/model.ts";
import { start } from "../core/agent.ts";
import { openMemory } from "../database/connection.ts";
import { remember } from "../session/store.ts";
import { reply } from "@shanepadgett/tau";

export const home = () => process.env["HOME"] ?? "";

export const host = { model, start, openMemory, remember, reply };
`,
  "src/extensions/greeting.ts": `import { reply } from "@shanepadgett/tau";

export const greet = () => reply("hello");
`,
  "src/tui/chat.ts": `import { AgentLive } from "../core/agent.ts";
import { reply } from "@shanepadgett/tau";

export const chat = { layer: AgentLive, reply };
`,
  "src/cli/main.ts": `import { Effect } from "effect";
import { greet } from "../extensions/greeting.ts";
import { home, host } from "../host/settings.ts";
import { chat } from "../tui/chat.ts";

const message = await Effect.runPromise(Effect.provide(greet(), chat.layer));
console.log(message.text, home(), host);
`,
  "tests/integration/events.test.ts": `import { expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { model } from "../../src/ai/model.ts";

test("builds a message with a platform layer available", () => {
  expect(model("hello").text).toBe("hello");
  expect(BunFileSystem.layer).toBeDefined();
});

test("awaits the event", async () => {
  const target = new EventTarget();

  const fired = new Promise<string>((resolve) => {
    target.addEventListener("done", (event) => resolve(event.type));
  });

  target.dispatchEvent(new Event("done"));
  expect(await fired).toBe("done");
});
`,
});

/** A function of 99 tokens over 8 lines, above the duplicate thresholds. */
const copy = (
  name: string,
) => `export const ${name} = (items: readonly { name: string; size: number }[]) => {
  const totals = new Map<string, number>();
  for (const item of items) {
    const previous = totals.get(item.name) ?? 0;
    totals.set(item.name, previous + item.size);
  }
  return [...totals.entries()].sort((left, right) => right[1] - left[1]);
};
`;

const copyWithLines = (name: string, count: number): string => {
  const lines = copy(name).trimEnd().split("\n");
  const merged = lines.length - count + 1;
  return `${[lines.slice(0, merged).join(" "), ...lines.slice(merged)].join("\n")}\n`;
};

const cases: readonly Case[] = [
  // Compiler and rule ownership
  {
    name: "compiler reports a type error and a floating Effect in one run",
    files: {
      "src/core/agent.ts": `import { Effect } from "effect";

export const count: number = "one";

export const run = () => {
  Effect.succeed(1);
  return Effect.void;
};
`,
    },
    command: task("check:types"),
    expected: {
      exitCode: 1,
      diagnostics: [
        "src/core/agent.ts(3,14): error TS2322",
        "src/core/agent.ts(6,3): error TS377001: This Effect value is neither yielded nor used in an assignment. effect(floatingEffect)",
      ],
    },
  },
  {
    name: "compiler accepts a typed Effect project",
    files: PROJECT,
    options: ENTRIES,
    command: task("check:types"),
    expected: { exitCode: 0, diagnostics: [] },
  },
  {
    name: "lint reports a floating promise and leaves floating Effects to the compiler",
    files: {
      "src/core/agent.ts": `import { Effect } from "effect";

export const run = () => {
  Effect.succeed(1);
  Promise.resolve(1);
};
`,
    },
    command: task("check:lint"),
    expected: {
      exitCode: 1,
      diagnostics: [
        "src/core/agent.ts:1:1: error tau(require-file-doc)",
        "src/core/agent.ts:5:3: error typescript(no-floating-promises)",
      ],
    },
  },
  {
    name: "compiler leaves floating promises to lint",
    files: {
      "src/core/agent.ts": `export const run = () => {
  Promise.resolve(1);
};
`,
    },
    command: task("check:types"),
    expected: { exitCode: 0, diagnostics: [] },
  },

  {
    name: "compiler rejects async functions and new Promise in src only",
    files: {
      "src/core/load.ts": `import { Effect } from "effect";

export const load = async () => 1;
export const wait = new Promise<number>((resolve) => resolve(1));
export const wrapped = Effect.tryPromise(async () => 1);
export const allowed = Effect.tryPromise(() => Promise.resolve(1));
`,
      "tools/load.ts": `export const load = async () => 1;
export const wait = new Promise<number>((resolve) => resolve(1));
`,
    },
    command: task("check:types"),
    expected: {
      exitCode: 1,
      diagnostics: [
        "src/core/load.ts(3,21): error TS377081",
        "src/core/load.ts(4,21): error TS377080",
        "src/core/load.ts(5,42): error TS377081",
      ],
    },
  },

  // Layer API policy
  {
    name: "lint rejects restricted APIs outside their layer",
    files: {
      "src/core/restricted.ts": `import { Effect } from "effect";

export const read = () => process.env["HOME"];
export const run = () => Effect.runPromise(Effect.void);
export const log = () => console.log("x");
export const get = () => fetch("https://example.com");
export const start = () => Bun.spawn(["true"]);

export const reflect = () => {
  Reflect.get({}, "a");
};
`,
    },
    command: task("check:lint"),
    expected: {
      exitCode: 1,
      diagnostics: [
        "src/core/restricted.ts:1:1: error tau(require-file-doc)",
        "src/core/restricted.ts:3:27: error tau(no-env)",
        "src/core/restricted.ts:4:26: error tau(no-effect-run)",
        "src/core/restricted.ts:5:26: error tau(no-console)",
        "src/core/restricted.ts:5:26: error typescript(no-confusing-void-expression)",
        "src/core/restricted.ts:6:26: error tau(no-fetch)",
        "src/core/restricted.ts:7:28: error tau(no-spawn)",
        "src/core/restricted.ts:10:3: error tau(no-reflect)",
      ],
    },
  },
  {
    name: "lint allows restricted APIs in their layer",
    files: documented({
      ...PROJECT,
      "src/ai/http.ts": `export const get = () => fetch("https://example.com");
`,
    }),
    options: ENTRIES,
    command: task("check:lint"),
    expected: { exitCode: 0, diagnostics: [] },
  },

  // Module state and names
  {
    name: "lint rejects module-level let in core and session",
    files: {
      "src/core/state.ts": `let count = 0;
export let total = 0;

export const next = () => (count += 1) + total;
`,
      "src/session/cursor.ts": `let position = 0;

export const advance = () => (position += 1);
`,
    },
    command: task("check:lint"),
    expected: {
      exitCode: 1,
      diagnostics: [
        "src/core/state.ts:1:1: error tau(no-module-let)",
        "src/core/state.ts:1:1: error tau(require-file-doc)",
        "src/core/state.ts:2:8: error tau(no-module-let)",
        "src/session/cursor.ts:1:1: error tau(no-module-let)",
        "src/session/cursor.ts:1:1: error tau(require-file-doc)",
      ],
    },
  },
  {
    name: "lint allows function-local let and host module state",
    files: documented({
      "src/core/counter.ts": `export const count = (items: readonly number[]) => {
  let total = 0;
  for (const item of items) total += item;
  return total;
};
`,
      "src/host/cache.ts": `let loaded = false;

export const load = () => {
  loaded = true;
  return loaded;
};
`,
    }),
    command: task("check:lint"),
    expected: { exitCode: 0, diagnostics: [] },
  },
  {
    name: "lint rejects generic file names, module mocks and sleeps",
    files: {
      "src/core/utils.ts": `export const one = 1;
`,
      "src/session/helpers/index.ts": `export const two = 2;
`,
      "tests/integration/mocked.test.ts": `import { mock, mock as replace, test, vi } from "bun:test";

void mock.module("node:os", () => ({}));
void replace.module("node:fs", () => ({}));
void vi.mock("node:path", () => ({}));

test("sleeps", async () => {
  await Bun.sleep(1);
  setTimeout(() => undefined, 1);
});
`,
    },
    command: task("check:lint"),
    expected: {
      exitCode: 1,
      diagnostics: [
        "src/core/utils.ts:1:1: error tau(no-generic-filenames)",
        "src/core/utils.ts:1:1: error tau(require-file-doc)",
        "src/session/helpers/index.ts:1:1: error tau(no-generic-filenames)",
        "src/session/helpers/index.ts:1:1: error tau(require-file-doc)",
        "tests/integration/mocked.test.ts:3:6: error tau(no-module-mock)",
        "tests/integration/mocked.test.ts:4:6: error tau(no-module-mock)",
        "tests/integration/mocked.test.ts:5:6: error tau(no-module-mock)",
        "tests/integration/mocked.test.ts:8:9: error tau(no-sleep)",
        "tests/integration/mocked.test.ts:9:3: error tau(no-sleep)",
      ],
    },
  },

  // Import boundaries, zone coverage and dead code
  {
    name: "fallow accepts every allowed layer edge, services and public SDK exports",
    files: PROJECT,
    options: ENTRIES,
    command: task("fallow:dead-code"),
    expected: { exitCode: 0, diagnostics: [] },
  },
  {
    name: "fallow rejects forbidden, type-only and self-reference imports and SQLite outside database",
    files: {
      ...PROJECT,
      "src/workspace/leak.ts": `import { Database } from "bun:sqlite";
import type { Message } from "../ai/model.ts";
import { version } from "@shanepadgett/tau";

export const leak = (message?: Message) => [Database.name, version, message].length;
`,
      "src/cli/main.ts": `${PROJECT["src/cli/main.ts"]}import { leak } from "../workspace/leak.ts";
console.log(leak());
`,
    },
    options: ENTRIES,
    command: task("fallow:dead-code"),
    expected: {
      exitCode: 1,
      diagnostics: [
        "policy-violation:src/workspace/leak.ts:1:bun:sqlite banned by tau-imports/sqlite-in-database",
        "boundary-violation:src/workspace/leak.ts:2:src/workspace/leak.ts -> src/ai/model.ts (workspace -> ai)",
        "boundary-violation:src/workspace/leak.ts:3:src/workspace/leak.ts -> src/sdk/index.ts (workspace -> sdk)",
      ],
    },
  },
  {
    name: "fallow rejects source outside every zone",
    files: {
      ...PROJECT,
      "src/stray/thing.ts": `export const thing = 1;
`,
      "src/cli/main.ts": `${PROJECT["src/cli/main.ts"]}import { thing } from "../stray/thing.ts";
console.log(thing);
`,
    },
    options: ENTRIES,
    command: task("fallow:dead-code"),
    expected: {
      exitCode: 1,
      diagnostics: ["boundary-coverage:src/stray/thing.ts:1:no matching boundary zone"],
    },
  },
  {
    name: "fallow rejects unused files, exports and dependencies, unresolved imports and cycles",
    files: {
      ...PROJECT,
      "src/core/orphan.ts": `export const orphan = 1;
`,
      "src/core/first.ts": `import { second } from "./second.ts";
import { missing } from "./missing.ts";

export const first = () => second() + missing;
export const unused = 1;
`,
      "src/core/second.ts": `import { first } from "./first.ts";

export const second = (): number => first();
`,
      "src/cli/main.ts": `${PROJECT["src/cli/main.ts"]}import { first } from "../core/first.ts";
console.log(first);
`,
    },
    options: {
      package: {
        ...ENTRIES.package,
        dependencies: { effect: "4.0.3", "left-pad": "1.3.0" },
        devDependencies: { ...MANIFEST.devDependencies, cowsay: "1.6.0" },
      },
    },
    command: task("fallow:dead-code"),
    expected: {
      exitCode: 1,
      diagnostics: [
        "unused-file:src/core/orphan.ts",
        "unused-export:src/core/first.ts:5:unused",
        "unused-dep:left-pad",
        "unused-devdep:cowsay",
        "unresolved-import:src/core/first.ts:2:./missing.ts",
        "circular-dependency:src/core/first.ts:1:src/core/first.ts → src/core/second.ts → src/core/first.ts",
      ],
    },
  },

  // Duplication
  {
    name: "fallow rejects a qualifying copy",
    files: { "src/core/sizes.ts": copy("sizes"), "src/session/totals.ts": copy("totals") },
    command: task("fallow:dupes"),
    expected: {
      exitCode: 1,
      diagnostics: [
        "code-duplication:src/core/sizes.ts:1-8:",
        "code-duplication:src/session/totals.ts:1-8:",
      ],
    },
  },
  {
    name: "fallow accepts a copy below the token threshold",
    files: {
      "src/core/sizes.ts": `export const sizes = (\n  items: readonly number[],\n) => {\n  return items.map((item) => item * 2);\n};\n`,
      "src/session/totals.ts": `export const totals = (\n  items: readonly number[],\n) => {\n  return items.map((item) => item * 2);\n};\n`,
    },
    command: task("fallow:dupes"),
    expected: { exitCode: 0, diagnostics: [] },
  },
  {
    name: "fallow accepts a token-rich copy below the line threshold",
    files: {
      "src/core/sizes.ts": copyWithLines("sizes", 4),
      "src/session/totals.ts": copyWithLines("totals", 4),
    },
    command: task("fallow:dupes"),
    expected: { exitCode: 0, diagnostics: [] },
  },
  {
    name: "fallow rejects a token-rich copy at the line threshold",
    files: {
      "src/core/sizes.ts": copyWithLines("sizes", 5),
      "src/session/totals.ts": copyWithLines("totals", 5),
    },
    command: task("fallow:dupes"),
    expected: {
      exitCode: 1,
      diagnostics: [
        "code-duplication:src/core/sizes.ts:1-5:",
        "code-duplication:src/session/totals.ts:1-5:",
      ],
    },
  },
];

describe("checks", () => {
  for (const testCase of cases) {
    test(testCase.name, () => runCase(testCase), TIMEOUT);
  }
});

const UNFORMATTED = `export const value   =  {a:1}\n`;
const FORMATTED = `export const value = { a: 1 };\n`;

describe("format", () => {
  test(
    "check reports unformatted files and leaves them unchanged",
    async () => {
      await using workspace = await createWorkspace({
        ...PROJECT,
        "src/core/value.ts": UNFORMATTED,
      });

      const result = await workspace.run(task("check:fmt"));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("src/core/value.ts");
      expect(await workspace.read("src/core/value.ts")).toBe(UNFORMATTED);
    },
    TIMEOUT,
  );

  test(
    "check reports a syntax error as a parse failure",
    async () => {
      await using workspace = await createWorkspace({ "src/core/value.ts": `export const = ;\n` });
      const result = await workspace.run(task("check:fmt"));
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("src/core/value.ts");
    },
    TIMEOUT,
  );

  test(
    "fixes only the supplied files, including awkward names, and is idempotent",
    async () => {
      const supplied = ["src/core/two words.ts", "src/core/it's.ts"];

      await using workspace = await createWorkspace({
        ...Object.fromEntries(supplied.map((path) => [path, UNFORMATTED])),
        "src/core/untouched.ts": UNFORMATTED,
      });

      for (let pass = 0; pass < 2; pass += 1) {
        const result = await workspace.run(task("fix:fmt", ...supplied));
        expect(result.exitCode, result.stderr).toBe(0);
        for (const path of supplied) expect(await workspace.read(path)).toBe(FORMATTED);
        expect(await workspace.read("src/core/untouched.ts")).toBe(UNFORMATTED);
      }
    },
    TIMEOUT,
  );
});

describe("lint fixes", () => {
  test(
    "receive awkward file names as single arguments",
    async () => {
      // Oxlint skips missing paths silently, so a reported diagnostic proves the path arrived intact.
      const path = "src/core/it's two words.ts";

      await using workspace = await createWorkspace({
        [path]: `export const run = () => {\n  Promise.resolve(1);\n};\n`,
      });

      const result = await workspace.run(task("fix:lint", path));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(`${path}:2:3: error typescript(no-floating-promises)`);
    },
    TIMEOUT,
  );
});

describe("failure output", () => {
  test(
    "passing checks print nothing",
    async () => {
      await using workspace = await createWorkspace(PROJECT, ENTRIES);

      for (const name of ["check:mise", "check:fmt", "check:types", "fallow:dead-code", "test"]) {
        const result = await workspace.run(task(name));
        const output = `${result.stdout}${result.stderr}`.trim();
        expect(result.exitCode, `${name}\n${output}`).toBe(0);
        expect(output, name).toBe("");
      }
    },
    TIMEOUT,
  );

  test(
    "a failing test prints its failure without banners, passing tests or summaries",
    async () => {
      await using workspace = await createWorkspace({
        ...PROJECT,
        "tests/integration/failing.test.ts": `import { expect, test } from "bun:test";\n\ntest("fails", () => {\n  expect(1).toBe(2);\n});\n`,
      });

      const result = await workspace.run(task("test"));
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("(fail) fails");
      expect(result.stdout).toContain("Received: 1");

      for (const noise of [
        "bun test v",
        "(pass)",
        " pass",
        "expect() calls",
        "Ran ",
        workspace.root,
      ]) {
        expect(result.stdout, noise).not.toContain(noise);
      }
    },
    TIMEOUT,
  );
});

describe("full check", () => {
  test(
    "passes a clean project with every gate",
    async () => {
      await using workspace = await createWorkspace({ ...PROJECT, ...REFERENCE }, ENTRIES);
      await syncReference(workspace);
      const result = await workspace.run(task("check"));
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "fails when the last gate fails",
    async () => {
      await using workspace = await createWorkspace(
        {
          ...PROJECT,
          ...REFERENCE,
          "tests/integration/failing.test.ts": `import { expect, test } from "bun:test";\n\ntest("fails", () => {\n  expect(1).toBe(2);\n});\n`,
        },
        ENTRIES,
      );

      await syncReference(workspace);
      const result = await workspace.run(task("check"));
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("[test] ERROR");
    },
    TIMEOUT,
  );

  test(
    "fails when tools are not installed, without downloading them",
    async () => {
      await using workspace = await createWorkspace(PROJECT, { ...ENTRIES, dependencies: "none" });

      for (const name of [
        "check:types",
        "check:lint",
        "check:fmt",
        "fallow:dead-code",
        "fallow:dupes",
        "check",
      ]) {
        const result = await workspace.run(task(name));
        expect(result.exitCode, name).not.toBe(0);
      }

      expect((await workspace.run(["test", "-e", "node_modules"])).exitCode).toBe(1);
    },
    TIMEOUT,
  );
});

describe("installation", () => {
  test("rejects an incompatible native compiler version without changing its binary", async () => {
    await using workspace = await createWorkspace({}, { dependencies: "none" });
    const install = await workspace.run(["bun", "install", "--frozen-lockfile"]);
    expect(install.exitCode, install.stderr).toBe(0);

    const native = join(
      workspace.root,
      "node_modules",
      `@typescript/typescript-${process.platform}-${process.arch}`,
    );

    const manifestPath = join(native, "package.json");
    const manifest: Record<string, unknown> = await Bun.file(manifestPath).json();
    const binary = Bun.file(join(native, "lib", "tsc"));
    const before = Bun.CryptoHasher.hash("sha256", await binary.arrayBuffer(), "hex");
    await Bun.write(manifestPath, JSON.stringify({ ...manifest, version: "7.99.0" }));
    const result = await workspace.run(["bun", "run", "prepare"]);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("version 7.99.0 is not supported");
    expect(Bun.CryptoHasher.hash("sha256", await binary.arrayBuffer(), "hex")).toBe(before);
  }, 180_000);

  test("frozen install and reinstall activate the patched compiler", async () => {
    await using workspace = await createWorkspace(
      {
        "src/core/agent.ts": `import { Effect } from "effect";\n\nexport const run = () => {\n  Effect.succeed(1);\n};\n`,
      },
      { dependencies: "none" },
    );

    for (let pass = 0; pass < 2; pass += 1) {
      const install = await workspace.run(["bun", "install", "--frozen-lockfile"]);
      expect(install.exitCode, install.stderr).toBe(0);
      const version = await workspace.run(["bunx", "--bun", "--no-install", "tsc", "--version"]);
      expect(version.stdout).toContain("+effect-tsgo.0.51.1");
      const types = await workspace.run(task("check:types"));
      expect(types.stdout).toContain("effect(floatingEffect)");
    }
  }, 180_000);
});
