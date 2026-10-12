import {
  noChainedAssertions,
  noWidenThenAssert,
  requireAssertionJustification,
} from "./assertion-rules.ts";
import { testRule } from "./rule-tester.ts";

testRule("no-chained-assertions", noChainedAssertions, {
  valid: [
    "export const text = value as string;",
    "export const letters = ['a', 'b'] as const;",
    "export const text = <string>value;",
  ],
  invalid: [
    {
      code: "export const id = input as unknown as string;",
      errors: [{ message: /Chained assertions/, line: 1, column: 18 }],
    },
    {
      code: "export const id = <string>(<unknown>input);",
      errors: [{ message: /Chained assertions/ }],
    },
    {
      code: "export const id = (input as object) as string;",
      errors: [{ message: /Chained assertions/ }],
    },
  ],
});

testRule("require-assertion-justification", requireAssertionJustification, {
  valid: [
    "// SAFETY: callers validate the id.\nexport const id = input as Id;",
    "// SAFETY: callers validate the id,\n// and the check is cheap.\nexport const id = input as Id;",
    "/* SAFETY: callers validate the id. */\nexport const id = input as Id;",
    "export const id = () => {\n  // SAFETY: validated upstream.\n  return input as Id;\n};",
    "// SAFETY: every field is checked above.\nexport const user = {\n  id: input.id,\n  name: input.name as Name,\n};",
    "export const letters = ['a'] as const;",
  ],
  invalid: [
    {
      code: "export const id = input as Id;",
      errors: [{ message: /SAFETY/, line: 1, column: 18 }],
    },
    { code: "// SAFETY:\nexport const id = input as Id;", errors: 1 },
    { code: "// NOTE: callers validate the id.\nexport const id = input as Id;", errors: 1 },
    { code: "// SAFETY: callers validate the id.\n\nexport const id = input as Id;", errors: 1 },
    { code: "export const id = <Id>input;", errors: 1 },
    { code: "export const id = {} as Id; // SAFETY: trailing comments do not count.", errors: 1 },
  ],
});

testRule("no-widen-then-assert", noWidenThenAssert, {
  valid: [
    "const input = load(); export const user = input as User;",
    "const input: Raw = load(); export const user = input as User;",
    "const input: unknown = load(); export const user = parse(input);",
    "let input: unknown; export const user = input;",
    "const input: unknown = load(); const copy = { input }; export const user = copy.input;",
  ],
  invalid: [
    {
      code: "const input: unknown = load(); export const user = input as User;",
      errors: [{ message: /widened and is asserted back/, line: 1, column: 51 }],
    },
    { code: "const input: any = load(); export const user = <User>input;", errors: 1 },
    { code: "const input: object = load(); export const user = input as User;", errors: 1 },
    {
      code: "const input: unknown = load(); export const a = input as A; export const b = input as B;",
      errors: 2,
    },
  ],
});
