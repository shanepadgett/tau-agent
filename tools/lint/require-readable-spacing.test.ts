import { requireReadableSpacing } from "./require-readable-spacing.ts";
import { testRule } from "./rule-tester.ts";

const error = (line: number) => ({ message: /blank line/, line });

testRule("require-readable-spacing", requireReadableSpacing, {
  valid: [
    "export const first = 1;\nexport const second = 2;",
    "export const run = () => {\n  if (a) return 1;\n  if (b) return 2;\n  return 3;\n};",
    "export const run = () => {\n  const first = 1;\n  const second = 2;\n\n  return {\n    first,\n    second,\n  };\n};",
    "import { a } from 'a';\nimport {\n  b,\n  c,\n} from 'b';\nimport { d } from 'd';",
    "export function parse(input: string): string;\nexport function parse(input: number): number;\nexport function parse(input: string | number) {\n  return input;\n}",
    "'use strict';\nexport const run = () => {\n  return 1;\n};",
    "export const first = 1; // note\n\nexport const run = () => {\n  return 1;\n};",
    "export const run = () => {\n  return 1;\n};\n\n// A comment about what follows.\nexport const second = 2;",
    "export const run = (flag: number) => {\n  switch (flag) {\n    case 1:\n      return 1;\n    default:\n      return 2;\n  }\n};",
    "export class Reader {\n  name = 'reader';\n  size = 1;\n\n  read() {\n    return 1;\n  }\n}",
  ],
  invalid: [
    {
      code: "export const first = 1;\nexport const run = () => {\n  return first;\n};\nexport const last = 2;",
      output:
        "export const first = 1;\n\nexport const run = () => {\n  return first;\n};\n\nexport const last = 2;",
      errors: [error(2), error(5)],
    },
    {
      code: "export const run = () => {\n  const total = 1;\n  for (const item of items) {\n    use(item);\n  }\n  return total;\n};",
      output:
        "export const run = () => {\n  const total = 1;\n\n  for (const item of items) {\n    use(item);\n  }\n\n  return total;\n};",
      errors: [error(3), error(6)],
    },
    {
      code: "export const run = () => {\n  const first = 1;\n  const second = {\n    first,\n  };\n  return second;\n};",
      output:
        "export const run = () => {\n  const first = 1;\n\n  const second = {\n    first,\n  };\n\n  return second;\n};",
      errors: [error(3), error(6)],
    },
    {
      code: "export const first = 1; // note\nexport const run = () => {\n  return 1;\n};",
      output: "export const first = 1; // note\n\nexport const run = () => {\n  return 1;\n};",
      errors: [error(2)],
    },
    {
      code: "export const run = () => {\n  return 1;\n};\n// What follows.\nexport const second = 2;",
      output:
        "export const run = () => {\n  return 1;\n};\n\n// What follows.\nexport const second = 2;",
      errors: [error(5)],
    },
    {
      code: "export const run = (flag: number) => {\n  switch (flag) {\n    case 1:\n      use(1);\n      if (flag) {\n        use(2);\n      }\n      return 1;\n    default:\n      return 2;\n  }\n};",
      output:
        "export const run = (flag: number) => {\n  switch (flag) {\n    case 1:\n      use(1);\n\n      if (flag) {\n        use(2);\n      }\n\n      return 1;\n    default:\n      return 2;\n  }\n};",
      errors: [error(5), error(8)],
    },
    {
      code: "export class Reader {\n  size = 1;\n  read() {\n    return 1;\n  }\n  write() {\n    return 2;\n  }\n}",
      output:
        "export class Reader {\n  size = 1;\n\n  read() {\n    return 1;\n  }\n\n  write() {\n    return 2;\n  }\n}",
      errors: [error(3), error(6)],
    },
  ],
});
