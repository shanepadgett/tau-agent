# WASM Tree-sitter structural tools

## Status

Research that justified WASM over a native helper. **Delivery plan:** [`explore-wasm-rewrite/`](explore-wasm-rewrite/README.md). Product contract: [`explore-specs/`](explore-specs/README.md). Do not treat this file as the build order.

## Problem

Tau needs fast structural orientation across source and documentation without making an agent read a whole large file first. The useful flow is:

1. get an outline with stable line ranges;
2. select a declaration or documentation section;
3. read only that range;
4. use syntax-aware searches when a name or construct matters.

This applies equally to source files and large Markdown documents such as the extension reference. A raw `read` of a multi-thousand-line document is a poor first operation when the agent only needs one heading or API section.

## Native helper experiment

A minimal Go helper was built locally to resemble a future extension sidecar:

- parses Go source with `go/parser`;
- emits a JSON outline of declarations;
- accepts a file, stdin, or `--self-test`;
- builds as a standalone ARM64 Mach-O (~3.45 MB).

The build succeeded, but execution did not:

```text
bin/ast-probe --self-test
Killed: 9

spctl --assess --type execute bin/ast-probe
rejected
```

The binary was Go linker/ad-hoc signed, not unsigned:

```text
Format=Mach-O thin (arm64)
flags=0x20002(adhoc,linker-signed)
```

This establishes that locally built Go executables are blocked on this managed Mac just as locally built Rust executables are. It does not establish the exact policy owner: Gatekeeper rejected the binary and endpoint protection may also account for `SIGKILL`.

### Consequence

Do not plan a required native helper for the first version of the extension. Debug versus release builds do not alter macOS trust policy, and ad-hoc signing is already present.

Possible future native deployment paths are organizational allow-listing, an internal signing/notarization pipeline, or Developer ID signing plus notarization. Those satisfy different trust layers and may still require endpoint-security approval. Do not depend on removing quarantine/provenance attributes or local Gatekeeper exceptions; managed policy can override them.

## Proposed runtime: Tree-sitter in WebAssembly

Run Tree-sitter in Tau's existing Node.js process with `web-tree-sitter` and language grammar `.wasm` files. The extension loads the runtime once, loads a grammar on demand, parses source in-process, and traverses nodes or executes Tree-sitter queries.

```text
Tau TypeScript extension
  ├─ web-tree-sitter runtime (.wasm)
  ├─ language grammar (.wasm), loaded by language id
  ├─ outline/query adapter
  └─ Tau tools: outline_file, read_section, structural_search
```

There is no child process, Go/Rust Mach-O, native Node `.node` addon, or sidecar JSON protocol. WebAssembly is still executable code and policy could restrict it, but it avoids the action proven to be rejected here: launching an unsigned local executable.

Conceptual use:

```ts
await Parser.init();
const language = await Parser.Language.load(grammarPath);
const parser = new Parser();
parser.setLanguage(language);

const tree = parser.parse(source);
const captures = new Parser.Query(language, query).captures(tree.rootNode);
```

Do **not** use the usual `tree-sitter-<language>` npm packages at runtime. They commonly expose native Node bindings. Reuse their grammar source, generated query files, or a compiled `.wasm` artifact instead.

Tau extensions can declare npm runtime dependencies in `package.json`; the grammar runtime and assets belong in normal production dependencies/package contents.

## Language coverage

Tree-sitter grammar source exists for every requested language.

| Language | Grammar/runtime note |
| --- | --- |
| Go | Standard Tree-sitter grammar; straightforward WASM. |
| Rust | Standard Tree-sitter grammar; straightforward WASM. |
| C# | Standard grammar; grammar artifact commonly uses `c_sharp`. |
| TypeScript | Standard grammar; separate artifact from TSX. |
| TSX | Standard grammar; separate artifact from TypeScript. |
| Odin | `tree-sitter-grammars/tree-sitter-odin` exists. Expect to build and vendor this artifact if the selected bundle lacks it. |
| Java | Standard Tree-sitter grammar; straightforward WASM. |
| Kotlin | `fwcd/tree-sitter-kotlin`; prebuilt artifacts are available in some collections. |
| Swift | `alex-pinkus/tree-sitter-swift`; prebuilt artifacts are available in some collections. |
| Markdown | Grammar exists, but needs a special delivery plan below. |

Prebuilt artifact collections can reduce packaging work but are not the source of truth. Examples include `@vscode/tree-sitter-wasm`, `@cursorless/tree-sitter-wasms`, and `tree-sitter-wasms`. Their language coverage, grammar revision, query files, and Tree-sitter ABI vary. The old `tree-sitter-wasms` package is not a safe default merely because it is convenient.

Recommended artifact policy:

1. Select one compatible `web-tree-sitter` runtime version.
2. Pin every grammar source revision and compile every selected grammar with the matching Tree-sitter CLI/runtime ABI in CI.
3. Commit or package the resulting `.wasm` files and required `.scm` queries.
4. Run a parse/query fixture for every supported language in CI.
5. Do not build grammars on the managed developer machine at extension runtime.

This removes ambiguity from mixed third-party WASM bundles and guarantees Odin is covered.

## Markdown is structurally different

The immediate product value from Markdown is a heading outline, not full CommonMark semantic analysis:

```json
[
  { "title": "Available Imports", "level": 2, "startLine": 91, "endLine": 142 },
  { "title": "Writing an Extension", "level": 2, "startLine": 143, "endLine": 381 }
]
```

Section end is derived from the next heading at the same or shallower level. The outline must ignore heading-looking text inside fenced code blocks.

Start with a small, tested Markdown heading scanner for this tool. It directly solves documentation orientation and avoids a known problem in the current CommonMark Tree-sitter grammar: its external scanner does not work with `web-tree-sitter` out of the box. The grammar also models block and inline parsing separately, which is useful for rich Markdown but unnecessary for heading ranges.

Later, if product needs links, list structure, injections in fenced code blocks, or semantic Markdown search, investigate a statically linked/custom WASM runtime or a tested compatible prebuilt Markdown artifact. That is a separate task from the first outline tool.

## Tool surface to target

Keep the first surface small:

### `outline_file`

Input: a project-relative file path.

Output: bounded, language-aware declaration or heading outline with kind, name/title, nesting level, and exact start/end lines. It should return structured details as well as human-readable text so later tools do not scrape display output.

### `read_section`

Input: a path plus an outline item id or a validated line range.

Output: only the selected range. This is the escape hatch from large-file raw reads.

### `structural_search`

Input: a supported language, scope, and a predefined query/search mode.

Output: matching syntax sites with ranges. Keep arbitrary Tree-sitter query text out of the first public tool surface; query validation and language-specific syntax are needless exposure until a real use case demands it.

For source outlines, language adapters map grammar nodes and queries into a common record such as:

```ts
type OutlineItem = {
  kind: "function" | "method" | "type" | "class" | "interface" | "heading";
  name: string;
  startLine: number;
  endLine: number;
  children?: OutlineItem[];
};
```

Language-specific detail stays behind the adapter. Agents get one reliable orientation contract.

## Query and outline assets

Grammar repositories and editor ecosystems often include Tree-sitter query files:

- `tags.scm` for symbols/tags;
- `folds.scm` for foldable regions;
- `highlights.scm` for highlighting;
- `injections.scm` for embedded languages.

Use existing `tags.scm` where its semantics fit. Add small Tau-owned outline queries where a grammar lacks tags or they do not match the desired agent-facing outline. Query fixtures must cover names, receiver/method forms, nested declarations, error recovery, and line ranges.

## Validation gates

Before treating this as a native-helper replacement, validate on the managed Mac:

1. Load the extension with only `web-tree-sitter` and one bundled Go grammar.
2. Parse an in-memory Go fixture and return an outline through a Tau tool.
3. Repeat for all requested grammars.
4. Run large Markdown heading-outline fixtures, including fenced code blocks and nested headings.
5. Measure startup cost, grammar load cost, parse latency, and package size.
6. Confirm output remains bounded and `read_section` prevents full-file context dumps.

If policy blocks WASM loading, stop and obtain an approved path from IT rather than designing an execution-policy bypass.

## Sources

- [Tree-sitter WASM bindings and grammar build instructions](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web)
- [Odin Tree-sitter grammar](https://github.com/tree-sitter-grammars/tree-sitter-odin)
- [Markdown Tree-sitter grammar and WASM limitation](https://github.com/tree-sitter-grammars/tree-sitter-markdown)
- [VS Code prebuilt Tree-sitter WASM artifacts](https://www.npmjs.com/package/@vscode/tree-sitter-wasm)
- [Cursorless prebuilt Tree-sitter WASM artifacts](https://www.npmjs.com/package/@cursorless/tree-sitter-wasms)
