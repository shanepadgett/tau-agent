import { describe, expect, test } from "bun:test";
import { runCase, task, TIMEOUT, type Case } from "./check-case.ts";
import { createWorkspace, documented } from "./workspace.ts";

const lint = task("check:lint");

/** One violation of each tau readability rule except spacing. Rule semantics are unit tested beside the rules. */
const RULES = `type Brand = string & { readonly brand: "brand" };
export const bare = (raw: string) => raw as Brand;
// SAFETY: this fixture only exercises the chained assertion rule.
export const chained = (raw: string) => raw as unknown as Brand;
export const parse = (input: unknown) => String(input);
export const store = (value: object) => value;
export const toggle = (enabled: boolean) => enabled;
export const load = (): unknown => 1;
export type Anything = unknown;
export type Bag = Record<string, unknown>;
export const isText = (value: string | number) => typeof value === "string";

export const read = () => {
  Reflect.get({}, "a");
};

export const options = (flag: string | undefined) => ({ ...(flag && { flag }) });
export const names = (items: readonly string[]) => items.filter(Boolean).map(String);
`;

const NOTES = `import { Effect } from "effect";

// const old = load();
// Required by docs/plan/tooling.md.

/** Gets the label. */
export const getLabel = () => "label";

export const read = () => {
  try {
    return 1;
  } catch (error) {
    throw new Error("failed");
  }
};

export const wrap = (start: number) =>
  Effect.gen(function* () {
    const first = yield* Effect.succeed(start);
    return first + (yield* Effect.succeed(2));
  });
`;

const SPACING = `/** Exercises the checks on a small sample module. */

export const first = 1;
export const second = 2;
export const third = () => {
  return first + second;
};
export const fourth = 4;
`;

const SPACED = `/** Exercises the checks on a small sample module. */

export const first = 1;
export const second = 2;

export const third = () => {
  return first + second;
};

export const fourth = 4;
`;

const cases: readonly Case[] = [
  {
    name: "tau readability rules apply to src and not to tests",
    files: {
      "src/core/rules.ts": RULES,
      "tests/integration/rules.ts": RULES,
    },
    command: lint,
    expected: {
      exitCode: 1,
      diagnostics: [
        "src/core/rules.ts:1:1: error tau(require-file-doc)",
        "src/core/rules.ts:2:38: error tau(require-assertion-justification)",
        "src/core/rules.ts:4:41: error tau(no-chained-assertions)",
        "src/core/rules.ts:5:23: error tau(no-unknown-parameters)",
        "src/core/rules.ts:6:23: error tau(no-object-parameters)",
        "src/core/rules.ts:7:24: error tau(no-boolean-parameters)",
        "src/core/rules.ts:8:23: error tau(no-unknown-returns)",
        "src/core/rules.ts:9:8: error tau(no-unknown-type-aliases)",
        "src/core/rules.ts:10:19: error tau(no-unsafe-dictionary-types)",
        "src/core/rules.ts:11:51: error tau(no-runtime-typeof)",
        "src/core/rules.ts:14:3: error tau(no-reflect)",
        "src/core/rules.ts:17:57: error tau(no-conditional-empty-spread)",
        "src/core/rules.ts:18:52: error tau(no-array-filter-map)",
      ],
    },
  },
  {
    name: "comment, error and Effect function rules apply to src and not to tests",
    files: {
      "src/core/notes.ts": NOTES,
      "tests/integration/notes.ts": NOTES,
    },
    command: lint,
    expected: {
      exitCode: 1,
      diagnostics: [
        "src/core/notes.ts:1:1: error tau(require-file-doc)",
        "src/core/notes.ts:3:1: error tau(no-commented-code)",
        "src/core/notes.ts:4:1: error tau(no-internal-references)",
        "src/core/notes.ts:6:1: error tau(no-restating-jsdoc)",
        "src/core/notes.ts:12:12: error eslint(no-unused-vars)",
        "src/core/notes.ts:13:11: error tau(error-needs-cause)",
        "src/core/notes.ts:18:3: error tau(prefer-effect-fn)",
        "tests/integration/notes.ts:12:12: error eslint(no-unused-vars)",
      ],
    },
  },
  {
    name: "lint rejects control flow and names that make code hard to follow",
    files: {
      "src/core/flow.ts": `export const label = (first: number, second: number) =>
  first > 1 ? (second > 1 ? "both" : "first") : "none";

export const pick = (count: number) => {
  if (count > 1) {
    return "many";
  } else {
    return "few";
  }
};

export const delay = (ms: number) => ms * 500;

export const describe = (count: number) => (count !== 0 ? "some" : "none");

export const deep = (items: readonly number[]) => {
  for (const item of items) {
    if (item > 1) {
      if (item > 2) {
        if (item > 3) {
          return item;
        }
      }
    }
  }

  return 0;
};

export const many = (one: number, two: number, three: number, four: number, five: number) =>
  one + two + three + four + five;

export const bump = (count: number) => {
  count += 1;
  return count;
};

export const lengths = (names: readonly string[]) =>
  names.reduce((byName, name) => byName.set(name, name.length), new Map<string, number>());

export const collect = (values: readonly number[]) => {
  const seen = new Set<number>();
  values.forEach((value) => seen.add(value));
  return seen;
};

export const first = (values: readonly string[]) => values[0]!;
`,
    },
    command: lint,
    expected: {
      exitCode: 1,
      diagnostics: [
        "src/core/flow.ts:1:1: error tau(require-file-doc)",
        "src/core/flow.ts:2:3: error eslint(no-nested-ternary)",
        "src/core/flow.ts:6:5: error eslint(no-else-return)",
        "src/core/flow.ts:12:43: error eslint(no-magic-numbers)",
        "src/core/flow.ts:14:45: error eslint(no-negated-condition)",
        "src/core/flow.ts:20:9: error eslint(max-depth)",
        "src/core/flow.ts:20:20: error eslint(no-magic-numbers)",
        "src/core/flow.ts:30:21: error eslint(max-params)",
        "src/core/flow.ts:34:3: error eslint(no-param-reassign)",
        "src/core/flow.ts:39:9: error unicorn(no-array-reduce)",
        "src/core/flow.ts:43:10: error unicorn(no-array-for-each)",
        "src/core/flow.ts:47:53: error typescript(no-non-null-assertion)",
      ],
    },
  },
  {
    name: "lint accepts code that reads well",
    files: documented({
      "src/core/clear.ts": `export const clamp = (value: number, limit: number) => {
  if (value < 0) return 0;
  if (value > limit) return limit;
  return value;
};

export const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

export const identity = <T>(value: T) => value;

export type Counts = Record<string, number>;
`,
    }),
    command: lint,
    expected: { exitCode: 0, diagnostics: [] },
  },
  {
    name: "lint requires blank lines around multiline statements and fixes them",
    files: {
      "src/core/spacing.ts": SPACING,
    },
    command: lint,
    expected: {
      exitCode: 1,
      diagnostics: [
        "src/core/spacing.ts:5:1: error tau(require-readable-spacing)",
        "src/core/spacing.ts:8:1: error tau(require-readable-spacing)",
      ],
    },
  },
];

describe("readability lint", () => {
  for (const testCase of cases) test(testCase.name, () => runCase(testCase), TIMEOUT);

  test(
    "the lint fix adds the blank lines and leaves the formatter satisfied",
    async () => {
      const path = "src/core/spacing.ts";
      await using workspace = await createWorkspace({ [path]: SPACING });
      const fixed = await workspace.run(task("fix:lint", path));
      expect(fixed.exitCode, fixed.stderr).toBe(0);
      expect(await workspace.read(path)).toBe(SPACED);
      const formatted = await workspace.run(task("check:fmt"));
      expect(formatted.exitCode, formatted.stdout).toBe(0);
    },
    TIMEOUT,
  );
});
