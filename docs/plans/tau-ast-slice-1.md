# Tau AST Slice 1

Status: complete

## Scope

Prove the native extraction boundary before Pi integration:

- a Rust worker under `packages/agent/native/tau-ast`
- a versioned, length-prefixed JSON protocol
- a handshake and single-file outline request
- built-in ast-grep TypeScript and TSX outline rules
- Tau-owned Odin rules over `tree-sitter-odin` 1.3.0
- parser diagnostics, fixtures, warm extraction reuse, and local benchmarks

Go, repository walking, locators, caching, cancellation, packaging, and Pi tools remain outside this slice.

## Fixed decisions

- Rust 1.88.0, matching ast-grep 0.45.0's minimum version.
- Published `ast-grep-core`, `ast-grep-language`, and `ast-grep-outline` crates pinned to 0.45.0.
- Published MIT `tree-sitter-odin` crate pinned to 1.3.0.
- TypeScript rules come from `ast_grep_outline::DEFAULT_OUTLINE_RULES`.
- Odin rules live in Tau because ast-grep has no Odin outline rules.
- Protocol frames use a four-byte big-endian payload length followed by UTF-8 JSON.
- Protocol version 1 requires a successful handshake before outline requests.
- The worker has no supported command-line interface.

## Exit checks

- TypeScript and Odin fixtures produce declarations and exact ranges.
- Syntax `ERROR` and `MISSING` nodes are counted.
- A private Odin declaration is marked unexported.
- Multiple framed requests work in one process.
- Warm extraction avoids recompiling outline rules.
- Cold process and warm request timings are recorded without wall-clock assertions in unit tests.

## Results

Measured on 24 July 2026 using the release build on macOS arm64. Each timing set used 20 iterations.

| Input | Bytes | Items | Parse errors | Cold median | Warm median |
| --- | ---: | ---: | ---: | ---: | ---: |
| `packages/agent/extensions/explore/index.ts` | 1,495 | 11 | 0 | 5.960 ms | 0.151 ms |
| `errata/tools/outline/fixtures/geom/vec.odin` | 1,173 | 15 | 0 | 5.864 ms | 0.172 ms |

The worker integration test launches the real binary, rejects an outline before handshake, then outlines TypeScript and Odin through the same process. Unit and integration tests pass under format and Clippy checks.

The Odin rules find every top-level declaration in the `errata` fixture, both `Circle` fields, procedure groups, and both private forms. Current rule-level gaps are classification rather than missed declarations: aliases, distinct types, and bit sets currently use the generic constant category, and enum members are not yet emitted.
