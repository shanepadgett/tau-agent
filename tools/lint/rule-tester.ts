import { describe, it } from "node:test";
import type { Rule } from "@oxlint/plugins";
import { RuleTester } from "oxlint/plugins-dev";

// node:test returns promises that RuleTester does not use.
RuleTester.describe = (text, fn) => {
  void describe(text, fn);
};

RuleTester.it = (text, fn) => {
  void it(text, fn);
};

type Cases = Parameters<RuleTester["run"]>[2];

/** A case that must not report. A bare string is the code. */
type Valid = Cases["valid"][number];

type Invalid = Cases["invalid"][number];

const withFile = <Case extends { readonly filename?: string }>(testCase: Case): Case => ({
  ...testCase,
  filename: testCase.filename ?? "example.ts",
});

const validCase = (testCase: Valid) =>
  withFile(typeof testCase === "string" ? { code: testCase } : testCase);

/**
 * Runs a rule's cases under `node --test`. Cases are TypeScript files unless one names its
 * own file. Error columns are 0-based, unlike the 1-based columns in lint output.
 *
 * Oxlint's `RuleTester` refuses to run under Bun, so rule tests run under Node. See
 * AGENTS.md for when to check whether that is still true.
 */
export const testRule = (name: string, rule: Rule, cases: Cases) => {
  new RuleTester().run(name, rule, {
    valid: cases.valid.map(validCase),
    invalid: cases.invalid.map((testCase: Invalid) => withFile(testCase)),
  });
};
