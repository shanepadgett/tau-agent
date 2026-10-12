import { noModuleLet } from "./no-module-let.ts";
import { testRule } from "./rule-tester.ts";

const error = (column: number) => ({ message: /Module-level mutable bindings/, line: 1, column });

testRule("no-module-let", noModuleLet, {
  valid: [
    "const count = 0;",
    "export const total = 0;",
    "export const next = () => { let count = 0; count += 1; return count; };",
    "declare let injected: number;",
  ],
  invalid: [
    { code: "let count = 0;", errors: [error(0)] },
    { code: "var count = 0;", errors: [error(0)] },
    { code: "export let total = 0;", errors: [error(7)] },
  ],
});
