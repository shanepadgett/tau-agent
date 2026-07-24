# Tau AST Local Export Resolution

Status: approved

## Goal

Make a public TypeScript or TSX outline point at the local declaration behind an end-of-file export list.

Given:

```ts
function createThing(name: string): Thing {
	return new Thing(name);
}

export { createThing };
```

The public outline should report the function declaration:

```text
public function
1-3(1): function createThing(name: string): Thing
```

Calling `symbol` with locator `1` should return lines 1-3, including the function body. It should not return `export { createThing };`.

This removes the current workaround of running a second outline with `includePrivate: true` and the same declaration name.

## Fixed scope

- Apply the change to TypeScript and TSX only.
- Resolve named local export clauses such as `export { createThing }` and `export type { InitiativeState }`.
- Preserve local export aliases such as `export { buildThing as createThing }`.
- Keep the locator range tied to the real local declaration.
- Keep cross-file re-exports, star exports, default exports, and export clauses containing unresolved bindings on their current path.
- Do not add SQL, Markdown, JSON, YAML, CSS, or framework-specific extraction.
- Do not change how much source `symbol` returns. It still returns the exact declaration, including its implementation body.
- Do not address truncated type-alias signatures in this change. That needs a separate extractor investigation.
- Do not change the worker protocol shape or protocol version.

## Expected behavior

### Unaliased local export

For:

```ts
const createParser = () => new FileParser();

export { createParser };
```

The existing `createParser` outline item becomes public. The synthetic export-list item is omitted. Its locator continues to encode the range of the `const` declaration.

### Aliased local export

For:

```ts
function buildThing(name: string): Thing {
	return new Thing(name);
}

export { buildThing as createThing };
```

The public outline should show the public and local identities:

```text
public function
1-3(1): createThing → function buildThing(name: string): Thing
```

The public projection uses:

- `name = "createThing"`;
- the symbol type, AST kind, source range, and locator from `buildThing`;
- `isExported = true`; and
- a synthetic signature of `createThing → <local signature>` for display.

`symbol(1)` returns the `buildThing` declaration and labels the block `createThing`.

Keep the original `buildThing` item private so these filters remain meaningful:

- public outline with `names: ["createThing"]` returns the public projection;
- public outline with `names: ["buildThing"]` returns no match;
- private outline with `names: ["buildThing"]` returns the local declaration; and
- a full private outline may show both the local declaration and its public alias because they are distinct names.

### Multiple aliases for one declaration

For:

```ts
function buildThing(): Thing {
	return new Thing();
}

export { buildThing as createThing, buildThing as makeThing };
```

The public outline contains one projection per public name. Both numeric locators may map to the same native source locator. A batched `symbol` request for both IDs sends the native locator once, then labels the returned block with both IDs and names.

### Unsupported export forms

Do not partially rewrite an export clause unless every specifier resolves to a non-import, top-level declaration in the same file. This keeps current behavior for cases such as:

```ts
export { createThing } from "./thing.ts";
export * from "./thing.ts";
export { localThing, importedThing };
```

The all-or-nothing rule avoids duplicate or misleading public entries in mixed clauses.

## Implementation

### 1. Capture the current extractor shape

Before changing transformation code, add a focused TypeScript fixture or temporary unit-test source containing:

- an unaliased function export;
- an aliased function export;
- a local type-only export;
- two aliases for one declaration;
- a cross-file re-export;
- a mixed local/imported export clause; and
- the equivalent unaliased case in TSX.

Inspect the raw `ast-grep-outline` items and relevant tree-sitter node kinds on a machine with Rust available. Record those expectations in tests rather than leaving debug output or a diagnostic mode in the worker.

This checkpoint matters because the current report establishes the bad user-visible result, but the exact shape of the extractor's synthetic export item has not been verified in this environment.

### 2. Resolve local export clauses in the native engine

Update `packages/agent/native/tau-ast/src/outline.rs`.

Run a TypeScript/TSX-specific normalization after extraction has produced owned `OutlineItem` values and before `filter_items` applies visibility and `names` filtering.

Use the parsed syntax tree to discover root-level named export clauses. Do not parse export statements with regular expressions or string splitting. For each clause:

1. Reject clauses with a module source, star export, default export, or unsupported specifier shape.
2. Read each specifier's local name and exported name.
3. Resolve every local name against non-import top-level outline items from the same file.
4. Leave the entire clause unchanged if any local name does not resolve.
5. For an unaliased specifier, mark each matching local item as exported.
6. For an aliased specifier, clone each matching local item into a public projection with the behavior described above. Leave the original item private.
7. Remove the extractor item or items representing that export clause only after the whole clause resolves.

Match all top-level items with the local name rather than assuming one item. TypeScript overloads and merged declarations may legitimately produce several declarations for one exported binding.

Keep source order stable. Put alias projections next to their underlying local declaration, and do not reorder unrelated items.

If cloning is needed, derive `Clone` only on the native outline model structs that participate in the projection. Avoid introducing a second parallel result model.

Generate alias signatures in the native engine so every client receives the same declaration label. `packages/agent/extensions/explore/ast-tools.ts` should remain a renderer, not learn TypeScript export syntax.

### 3. Preserve many numeric IDs for one native locator

Update `packages/agent/extensions/explore/ast-tools.ts`.

The tool already deduplicates native locator tokens before calling `client.symbol`. Keep that behavior. Replace the single `LocatorRecord` lookup per token with a list of records per token when formatting returned blocks.

For two requested numeric IDs that share one native token, render both:

```text
1-3(1,2): createThing, makeThing
```

Do not collapse the local numeric IDs merely because the native worker needs only one source range. Unknown and stale IDs must continue to fail atomically before the worker call.

No changes are required in `packages/agent/extensions/explore/ast-worker.ts`, `packages/agent/native/tau-ast/src/protocol.rs`, or `packages/agent/native/tau-ast/src/main.rs` unless the implementation reveals an actual protocol defect. The existing response model can represent the resolved declaration range.

### 4. Native tests

Add focused tests in `packages/agent/native/tau-ast/src/outline.rs` or a dedicated fixture-backed test module.

Cover:

- a public outline reports the underlying declaration and omits the trailing export-list item;
- `symbol` returns the declaration source rather than the export statement;
- a local type-only export resolves;
- an alias uses the public name while retaining the local declaration range and source;
- multiple aliases share the declaration source correctly;
- `include_private` and `names` follow the filtering behavior above;
- TypeScript and TSX both normalize local exports;
- a cross-file re-export remains unchanged;
- a mixed local/imported clause remains unchanged as a whole;
- overloads or merged top-level declarations are not silently dropped; and
- stale-locator rejection still works for a resolved export locator.

Prefer exact range and source assertions over snapshots of the whole worker response.

Extend `packages/agent/native/tau-ast/tests/worker.rs` with one end-to-end local-export case. Assert that the framed outline response contains the local declaration's range, then send that locator to `symbol` and compare the returned source with the declaration slice.

### 5. TypeScript tool tests

Update `packages/agent/test/extensions/explore/ast-tools.test.ts` with a mocked outline result containing two entries with different public names and the same native locator.

Assert that:

- both entries receive distinct numeric IDs;
- one `symbol` call with both IDs sends one native locator token;
- the rendered block contains both numeric IDs and both public names; and
- stale and unknown locator handling remains atomic.

`packages/agent/test/extensions/explore/ast-worker.test.ts` should not need semantic export tests because it only verifies framing and worker lifecycle.

## Validation

Run on a machine where the pinned Rust 1.88.0 toolchain works:

1. `mise run test:rust`
2. `npx vitest run packages/agent/test/extensions/explore/ast-tools.test.ts packages/agent/test/extensions/explore/ast-worker.test.ts`
3. `mise run check:rust`
4. `mise run check:ts`

Then run the real tools against a small TypeScript file with declarations followed by an end-of-file export list. Confirm the public outline points to declaration lines and `symbol` returns those declarations.

Also check one repository that uses end-of-file exports heavily. Compare its public outline before and after the change for duplicate entries, missing aliases, and accidental changes to cross-file re-exports.

## Acceptance criteria

- Public TypeScript and TSX outlines resolve fully local named export clauses to their underlying declarations.
- `symbol` returns the declaration source for those public locators.
- Public aliases remain visible by their exported names and identify the local declaration in the outline signature.
- Exact-name filtering works for public aliases and private local names.
- Multiple public aliases for one declaration retain distinct numeric tool locators while causing only one native source retrieval.
- Cross-file, star, default, unresolved, and mixed export forms retain their existing behavior.
- Existing visibility, context-line merging, stale-locator checks, cancellation, and worker framing continue to pass.
- No protocol version bump or new public tool parameter is introduced.
