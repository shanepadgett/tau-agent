import { noCommentedCode, noInternalReferences, noNarrationComments } from "./comment-rules.ts";
import { testRule } from "./rule-tester.ts";

testRule("no-narration-comments", noNarrationComments, {
  valid: [
    "// SAFETY: callers validate the id.\nexport const id = input as Id;",
    "// TODO: return the cached value\nexport const id = 1;",
    "// Return early because the cache is warm.\nexport const id = 1;",
    "// Retries stop after three attempts to avoid hammering the API.\nexport const id = 1;",
    "/** Create the session for a workspace. */\nexport const id = 1;",
    "/* Import the helpers */\nexport const id = 1;",
    "// The cache must be cleared before the next run starts today.\nexport const id = 1;",
    "// oxlint-disable-next-line no-console\nconsole.log('x');",
    "export const id = 1; // Resolve ids in two passes so cycles terminate.",
  ],
  invalid: [
    {
      code: "// Import the helpers\nexport const id = 1;",
      errors: [{ message: /restates the next line/, line: 1 }],
    },
    { code: "// Return the result\nexport const id = 1;", errors: 1 },
    { code: "// Create a new session\nexport const id = 1;", errors: 1 },
    { code: "export const id = 1; // Set the id", errors: 1 },
    { code: "// increment counter\n// Loop over items\nexport const id = 1;", errors: 2 },
  ],
});

testRule("no-commented-code", noCommentedCode, {
  valid: [
    "// Retries stop after three attempts to avoid hammering the API.\nexport const id = 1;",
    "// See the fetch(url) call in the loader.\nexport const id = 1;",
    "// TODO: const id = 1;\nexport const id = 1;",
    "/**\n * Loads the id.\n * @example\n * const id = load();\n */\nexport const id = 1;",
    "// Note(shane): the id is stable across restarts.\nexport const id = 1;",
    "// Returns the id; callers cache it.\nexport const id = 1;",
    "export const id = 1; // the first id",
  ],
  invalid: [
    {
      code: "// const id = load();\nexport const id = 1;",
      errors: [{ message: /comment is code/, line: 1 }],
    },
    { code: "// import { load } from './load.ts';\nexport const id = 1;", errors: 1 },
    { code: "// return id;\nexport const id = 1;", errors: 1 },
    { code: "// load(id);\nexport const id = 1;", errors: 1 },
    { code: "// if (cached) {\nexport const id = 1;", errors: 1 },
    { code: "// state.id = 2;\nexport const id = 1;", errors: 1 },
    { code: "/* const id = load();\n   save(id); */\nexport const id = 1;", errors: 1 },
    { code: "// }\nexport const id = 1;", errors: 1 },
  ],
});

testRule("no-internal-references", noInternalReferences, {
  valid: [
    "// Retries stop after three attempts to avoid hammering the API.\nexport const id = 1;",
    "// See https://github.com/oven-sh/bun/issues/123 for the crash.\nexport const id = 1;",
    "// Matches the #1 ranked result.\nexport const id = 1;",
    "// Written by hand because the generated client is slow.\nexport const id = 1;",
  ],
  invalid: [
    {
      code: "// Required by docs/plan/architecture.md.\nexport const id = 1;",
      errors: [{ message: /plan, standard, spike or ticket/, line: 1 }],
    },
    { code: "// Fixed in PR #42.\nexport const id = 1;", errors: 1 },
    { code: "// Follows tooling.md.\nexport const id = 1;", errors: 1 },
    { code: "// See spike 6.\nexport const id = 1;", errors: 1 },
    { code: "// Done in phase zero.\nexport const id = 1;", errors: 1 },
    { code: "// Tracked in #123.\nexport const id = 1;", errors: 1 },
    { code: "/** Defined in AGENTS.md. */\nexport const id = 1;", errors: 1 },
  ],
});
