import { noGenericFilenames } from "./no-generic-filenames.ts";
import { testRule } from "./rule-tester.ts";

const error = (name: string) => ({
  message: new RegExp(`\\\`${name}\\\` does not name a concept`),
});

testRule("no-generic-filenames", noGenericFilenames, {
  valid: [
    { code: "export const one = 1;", filename: "session-store.ts" },
    { code: "export const one = 1;", filename: "folder/model.ts" },
    { code: "export const one = 1;", filename: "utilization.ts" },
  ],
  invalid: [
    { code: "export const one = 1;", filename: "utils.ts", errors: [error("utils.ts")] },
    {
      code: "export const one = 1;",
      filename: "folder/helpers/index.ts",
      errors: [error("helpers")],
    },
    {
      code: "export const one = 1;",
      filename: "Common.test.ts",
      errors: [error("Common.test.ts")],
    },
    { code: "export const one = 1;", filename: "misc.d.ts", errors: [error("misc.d.ts")] },
  ],
});
