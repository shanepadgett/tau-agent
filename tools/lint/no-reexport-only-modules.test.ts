import { noReexportOnlyModules } from "./no-reexport-only-modules.ts";
import { testRule } from "./rule-tester.ts";

const error = { message: /only re-exports other modules/ };

testRule("no-reexport-only-modules", noReexportOnlyModules, {
  valid: [
    "",
    'import { run } from "./run.ts";\nrun();',
    'export { run } from "./run.ts";\nexport const stop = () => undefined;',
    'import { run } from "./run.ts";\nexport const start = run;',
  ],
  invalid: [
    { code: 'export * from "./run.ts";', errors: [error] },
    { code: 'export * as runs from "./run.ts";', errors: [error] },
    { code: 'export { run, type Run } from "./run.ts";', errors: [error] },
    { code: 'import { run } from "./run.ts";\nexport { run };', errors: [error] },
  ],
});
