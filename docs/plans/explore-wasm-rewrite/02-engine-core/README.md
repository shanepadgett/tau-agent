# Task 02 — Engine core: IR, adapter interface, parse cache, Markdown scanner

## Goal

The spine everything else plugs into: canonical IR types, the `LanguageAdapter` interface, the registry, the parse/IR cache, budget-aware directory scanning, and the Markdown heading scanner.

Specs: `explore-specs/cross/system.md` (language model, shared cache, lifecycle), `explore-specs/cross/path-conventions.md` (budgets).

## Files (all under `packages/agent/extensions/explore/ast/`)

```text
ir.ts          IR types + shared declaration-kind vocabulary
adapter.ts     LanguageAdapter interface + capability flags
registry.ts    adapter registration, extension→language map, advertisement
engine.ts      web-tree-sitter host, parse→extract→delete, IR cache, invalidation
markdown.ts    heading scanner producing FileIr for .md/.markdown/.mdown
scan.ts        budgeted ignore-aware multi-file IR production (uses ../traverse.ts from task 00)
```

Stage with `// fallow-ignore-file unused-file -- wired by task 13-switchover` until wired.

## IR shape (plain JSON-able objects only)

```ts
type DeclKind = "module" | "namespace" | "package" | "class" | "method" | "property" |
  "field" | "constructor" | "enum" | "interface" | "function" | "variable" |
  "constant" | "object" | "enumMember" | "struct" | "event" | "operator" |
  "typeParameter" | "heading"; // extend only for a real new kind (system.md)

type Decl = {
  kind: DeclKind;
  name: string;
  qualifiedName: string;          // dotted owner.member path
  startLine: number; endLine: number;          // 1-indexed, inclusive
  startByte: number; endByte: number;
  signatureEndByte: number;       // decl start → body open; signature = source slice
  bodyStartByte?: number; bodyEndByte?: number; // absent when no body
  docStartByte?: number; docEndByte?: number;   // attached doc comment span
  visibility: "public" | "private" | "protected" | "internal";
  exported: boolean;
  children: Decl[];
};

type FileIr = {
  path: string;
  contentHash: string;            // sha256 of bytes
  languageId: string;
  lineCount: number;
  decls: Decl[];
  imports: { specifier: string; startLine: number }[];
  parseDegraded: boolean;         // any ERROR/MISSING nodes present
};
```

## Adapter interface

```ts
type LanguageCapabilities = {
  shape: boolean; search: boolean; fileDeps: boolean;
  callEdges: boolean; packageSurface: boolean;
};

type LanguageAdapter = {
  id: string;                     // manifest grammar id; markdown has no grammar
  extensions: string[];           // ".ts" style, lowercase
  capabilities: LanguageCapabilities;
  extract(tree: Parser.Tree, source: string): ExtractResult; // decls + imports
};

The engine resolves grammar bytes with `grammarWasmPath`/`runtimeWasmPath` from
`ast/grammars/manifest.ts` (task 01) — no other module touches wasm paths.
```

`registry.ts` exposes `adapterForPath(path)`, `registeredLanguages()`, and per-language capability lookup. Tools never switch on language ids; they ask the registry. **No `language ===` conditionals outside adapters.**

## Engine rules

- Lazy init: `Parser.init` once on first structural call; `Language.load` per adapter on first use; cache loaded `Language` objects for the session.
- `irForFile(path)`: read bytes → hash → cache hit returns cached IR → else parse, `adapter.extract`, **`tree.delete()` in a `finally`**, cache, return. One `Parser` instance reused; call `parser.reset()`/`setLanguage` per parse as the API requires.
- `invalidate(paths)` and `clear()` on the cache. Wire invalidation to `tau:file-mutation.applied` (see `packages/agent/shared/events.ts`; the patch extension emits it) in task 13.
- `scan.ts`: async iterator over `FileIr` for a directory scope; enforces the four budgets; `await new Promise(setImmediate)` between files; checks `AbortSignal` per file; reports which budget tripped as structured data (not prose).
- Engine shutdown deletes retained `Language`/`Query` WASM objects. Register on session shutdown in task 13.

## Markdown scanner

Pure TS, no grammar. ATX headings (`#` … `######`) only; lines inside fenced code blocks (``` or `~~~`, fence length ≥ 3, matching closer) are not headings. Each heading becomes a `Decl` with `kind: "heading"`; section range runs to the line before the next heading of same-or-shallower depth, else EOF. Nest deeper headings as children. Test fixtures: fenced code containing `# fake heading`, nested levels, heading at EOF, CRLF input.

## Tests

Unit tests for cache hit/miss/invalidate, budget tripping, abort mid-scan, Markdown fixtures. Use the task-01 grammars with a stub adapter (real adapters arrive in task 03; a minimal inline TS extractor for one node type is fine here and gets replaced).
