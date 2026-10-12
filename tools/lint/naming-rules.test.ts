import { noVagueIdentifiers } from "./naming-rules.ts";
import { testRule } from "./rule-tester.ts";

testRule("no-vague-identifiers", noVagueIdentifiers, {
  valid: [
    "const users = load();",
    "const { data } = await response.json();",
    "export const parse = (input: string) => input;",
    "export const read = () => ({ data: 1, result: 2 });",
    "const reducer = 1; const databases = 2;",
  ],
  invalid: [
    {
      code: "const data = load();",
      errors: [{ message: /`data` says nothing/, line: 1, column: 6 }],
    },
    { code: "let result = 0;", errors: 1 },
    { code: "const tmp = 1, temp = 2;", errors: 2 },
    { code: "export const parse = (obj: string) => obj;", errors: 1 },
    { code: "export function parse(val: string, info = 1) { return [val, info]; }", errors: 2 },
  ],
});
