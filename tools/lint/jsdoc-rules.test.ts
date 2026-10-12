import { noRestatingJsdoc, requireFileDoc } from "./jsdoc-rules.ts";
import { testRule } from "./rule-tester.ts";

testRule("no-restating-jsdoc", noRestatingJsdoc, {
  valid: [
    "/** Loads the user from the cache, falling back to the database. */\nexport const getUser = () => 1;",
    "/** Create the session for a workspace. */\nexport const createSession = () => 1;",
    "export const getUser = () => 1;",
    "/** Retries stop after three attempts. */\nexport const getUser = () => 1;",
    "/**\n * Reads the user row, or fails when it is missing.\n * @param id - Primary key in the users table.\n */\nexport function loadUser(id: string) { return id; }",
    "/** Result of a query. */\nexport const a = 1, b = 2;",
    "/** Gets the user. */\nconst { getUser } = api;",
    "/** Total of all items. */\ninterface Cart {\n  /** Price in cents, tax excluded. */\n  price: number;\n}",
  ],
  invalid: [
    {
      code: "/** Gets the user. */\nexport const getUser = () => 1;",
      errors: [{ message: /repeats the name/, line: 1 }],
    },
    { code: "/** The user id. */\nexport const userId = 1;", errors: 1 },
    { code: "/** Creates a session */\nfunction createSession() { return 1; }", errors: 1 },
    { code: "/** Session options. */\nexport interface SessionOptions { id: string }", errors: 1 },
    {
      code: "export class Store {\n  /** Opens the store. */\n  openStore() { return 1; }\n}",
      errors: 1,
    },
    {
      code: "interface Cart {\n  /** The price. */\n  price: number;\n}",
      errors: 1,
    },
    {
      code: "/**\n * Loads the user from the cache.\n * @param userId - The user ID.\n */\nexport function loadUser(userId: string) { return userId; }",
      errors: 1,
    },
  ],
});

const DOC =
  "/** Opens SQLite files and runs write transactions that hold the lock across async work. */";

testRule("require-file-doc", requireFileDoc, {
  valid: [
    `${DOC}\n\nimport { x } from "y";\nexport const a = x;`,
    `${DOC}\n\n/** Opens a database. */\nexport const open = () => 1;`,
    `/**\n * Stores credentials per provider and refreshes OAuth tokens one process at a time,\n * so two windows never log each other out.\n */\n\nexport const a = 1;`,
    `${DOC}\n`,
    {
      code: `/** Reads and writes the user's API keys and OAuth tokens. */\n\nexport const a = 1;`,
      filename: "credential-store.ts",
    },
  ],
  invalid: [
    { code: "export const a = 1;", errors: [{ message: /Start the file/, line: 1, column: 0 }] },
    { code: `import { x } from "y";\n\n${DOC}\n\nexport const a = x;`, errors: 1 },
    { code: `// Opens SQLite files.\n\nexport const a = 1;`, errors: 1 },
    { code: `/* Opens SQLite files. */\n\nexport const a = 1;`, errors: 1 },
    { code: `${DOC}\nexport const a = 1;`, errors: 1 },
    { code: `/** */\n\nexport const a = 1;`, errors: 1 },
    {
      code: `/**\n * This module provides a comprehensive, robust and flexible set of utilities for opening,\n * migrating, querying and transacting against SQLite databases in a scalable manner,\n * ensuring best practices throughout.\n */\n\nexport const a = 1;`,
      errors: [{ message: /one or two plain sentences/ }],
    },
    {
      code: `/**\n * Opens databases.\n * @module database\n */\n\nexport const a = 1;`,
      errors: 1,
    },
    {
      code: `/** Credential store. */\n\nexport const a = 1;`,
      filename: "credential-store.ts",
      errors: [{ message: /repeats the file name/ }],
    },
  ],
});
