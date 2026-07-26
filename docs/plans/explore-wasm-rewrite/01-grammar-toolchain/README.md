# Task 01 — Grammar toolchain and WASM artifacts

## Cold start

**DONE.** Do not re-run unless bumping grammars. Fresh windows implementing later tasks: use `ast/grammars/manifest.ts` only; do not rebuild wasm casually.

## Status: done, gate passed

2026-07-26: all nine grammars load and parse through `web-tree-sitter@0.26.11` on the managed Mac (`packages/agent/test/extensions/explore/grammars.test.ts`, 10/10). WASM execution is proven policy-safe (earlier standalone probe: `~/dev/personal/go-test/WASM_PROBE_RESULTS.md`). The plan proceeds.

## What was built

### Sourcing (recorded in `packages/agent/extensions/explore/ast/grammars/manifest.json`)

| id | source | artifact |
| --- | --- | --- |
| typescript, tsx, go, rust, c_sharp, java | `vscode` | prebuilt in `@vscode/tree-sitter-wasm@0.3.1` (npm dependency), resolved from `node_modules` at runtime |
| kotlin | `built` | `kotlin.wasm` compiled from `fwcd/tree-sitter-kotlin` 0.3.8, committed |
| swift | `release` | `swift.wasm` downloaded from `alex-pinkus/tree-sitter-swift` 0.7.3 release asset, committed |
| odin | `built` | `odin.wasm` compiled from `tree-sitter-grammars/tree-sitter-odin` v1.3.0, committed |
| runtime | npm | `web-tree-sitter.wasm` resolved from the `web-tree-sitter@0.26.11` package |

Never rebuild what upstream ships prebuilt. Swift is a release download because compiling its generated parser OOMs a 6 GB container; upstream builds it in their CI.

### Pieces

- `packages/agent/extensions/explore/ast/grammars/manifest.ts` — typed manifest loader plus `grammarWasmPath(pin)` / `runtimeWasmPath()` resolution. Engine and tests go through these; nothing else hardcodes wasm paths.
- `packages/agent/scripts/build-grammars.ts` — rebuilds only `built`/`release` grammars; validates the `web-tree-sitter`, `@vscode/tree-sitter-wasm`, and `tree-sitter-cli` pins first. CI/maintainer-only.
- `.github/workflows/grammars.yml` — manual dispatch + PR paths trigger; rebuilds and fails on byte drift, then runs the smoke test. Runs on `ubuntu-24.04-arm` to match the committed arm64-built artifacts.
- `packages/agent/test/extensions/explore/grammars.test.ts` — loads every manifest grammar, parses a fixture (Kotlin string template and Swift interpolation exercise the compiled external scanners), asserts root node type and zero errors, deletes trees.
- `tree-sitter-cli@0.26.11` root devDependency with an `allowScripts` approval; CI activates it via `npm rebuild tree-sitter-cli` after `npm ci --ignore-scripts`.

## Managed-Mac build procedure (for future grammar bumps)

Automated: `mise run grammars:build` (`packages/agent/scripts/build-grammars-container.sh`); setup requirements are in `docs/CONTRIBUTING.md`. What it does and why:

Local toolchains die: wasi-sdk clang is an unsigned downloaded binary and endpoint policy kills it (`Killed: 9`). Native Apple clang has no wasi sysroot. Build inside a Linux container instead:

1. Pull the container image per your environment's registry policy — set `TAU_GRAMMAR_IMAGE` to a mirror-hosted `node:24-trixie` when direct Docker Hub pulls are not allowed (bookworm's glibc 2.36 is too old for the CLI binary; trixie works).
2. Download on the host (host TLS trust works): `tree-sitter-linux-arm64.gz` from the pinned tree-sitter release and `wasi-sdk-29.0-arm64-linux.tar.gz`; clone grammar repos at their pinned revs.
3. Mount everything from under `$HOME` (Rancher Desktop mangles `/tmp` single-file mounts) and run the container with `--network none`: unpack the CLI to `/usr/local/bin/tree-sitter`, untar wasi-sdk into `/root/.cache/tree-sitter/wasi-sdk` with `--strip-components=1`, `tree-sitter generate` where `src/parser.c` is missing, then `tree-sitter build --wasm -o /out/<id>.wasm <src>`.
4. Do not route container traffic through the corporate proxy or touch certificate material — the offline mount setup exists precisely to avoid that.

CI (Linux) runs the build script directly; none of this container ceremony applies there.

## Pinned versions

All in the manifest: `web-tree-sitter@0.26.11`, `@vscode/tree-sitter-wasm@0.3.1`, `tree-sitter-cli@0.26.11`, `wasi-sdk-29`, plus per-grammar repo/tag/rev.
