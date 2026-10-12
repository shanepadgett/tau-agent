# Toolchain

## Question and result

Can TypeScript 7 plus `@effect/tsgo` be the only type checker, alongside oxlint type-aware rules and a clean-room JS plugin?

**Yes on macOS arm64, with a scaling limit.** All 27 behavior checks pass. A single patched `tsc` run reports both TS2322 and an Effect diagnostic and fails. Type-aware and custom lint rules fire, and layer overrides allow environment reads and module state in `host` while rejecting them in `core`. At 3,000 generated Effect-heavy files with bounded dependencies, full lint takes 5.33 s and about 4.5 GiB peak memory. An unbounded schema chain becomes much slower.

## Setup and reproduction

Tested on Bun 1.4.3, Apple M4, 24 GiB RAM, Darwin arm64. Versions are pinned in `package.json`: Effect 4.0.3, TypeScript 7.0.2, `@effect/tsgo` 0.51.1, oxlint 1.87.0 and oxlint-tsgolint 7.0.2003. The Effect patch supports tsgolint 7.0.2001 and 7.0.2003, not the newer 7.0.2004.

From `spikes/toolchain/`:

```sh
bun install
bunx effect-tsgo patch --typescript --oxlint
bun run.ts
# Optional stress corpus: schemas depend on every preceding module.
bun run.ts 300,1000 deep
```

The patch replaces installed native binaries. Production needs a prepare script for the TypeScript patch after installs. The oxlint patch adds the Effect plugin; upstream calls that integration experimental. The fixture intentionally tests Effect diagnostics through both tools; production should keep one owner per rule.

`run.ts` copies fixtures, injects errors, and checks exit codes and diagnostic names. It times three fresh processes per variant and reports medians, including process startup. Peak RSS comes from macOS `/usr/bin/time -l`. Sources go in `fixtures/generated/` and are removed in `finally`: oxlint skips gitignored `.work/`, even when passed `src`. Explicit `src` paths avoid traversing the symlinked dependencies.

## Measurements

Each generated file has schemas, tagged errors, a service, a layer, Effect operations and plain helpers. The bounded corpus resets the dependency chain every eight files. Counts exclude the two base fixture files. All timed bounded runs exit zero; filesystem caches are warm.

| Command variant | 300 files | 1,000 files | 3,000 files | Peak RSS at 3,000 |
| --- | --- | --- | --- | --- |
| `tsc`: types + Effect | 0.47 s | 1.56 s | 5.24 s | 4,598 MiB |
| oxlint: type-aware + Effect + JS | 0.59 s | 1.69 s | 5.33 s | 4,562 MiB |
| oxlint `--type-check`: all checks | 0.72 s | 2.28 s | 6.90 s | 7,248 MiB |
| oxlint: type-aware, no Effect or JS | 0.28 s | 0.75 s | 2.47 s | 3,079 MiB |
| oxlint: syntax + JS only | 0.14 s | 0.28 s | 0.66 s | 107 MiB |

The original deep-chain corpus took 14.25 s for `tsc` and 15.06 s for full lint at 1,000 files. The complete benchmark exceeded its 600 s limit during the 3,000-file `tsc` stage; no completed 3,000-file timing exists for that shape. File count alone is not a useful performance prediction.

## Decision and limits

Keep the planned split: patched `tsc` owns types and Effect diagnostics; oxlint owns other type-aware and syntax rules. The single-command oxlint alternative works, but its type checking and Effect integration are experimental and its peak memory is higher. The timings do not establish which production split is fastest: the exact type-aware-plus-JS-only combination was not timed.

Per-file Effect diagnostic overrides work with `src/host/**/*.ts`; the earlier `src/host/**` pattern did not match. Oxlint's layer overrides work for the tested custom and Effect rules. The syntax plugin is a two-rule proof, not a production rule suite; it does not establish complete alias, computed-property or exported-declaration coverage.

Dev-tool spike: no compiled Tau binary is needed. Linux, editor integration, an actual Tau-sized codebase, incremental checking and cold-cache performance were not tested. Even variants without Effect rules used patched oxlint binaries. The results establish viability, not a guarantee of low memory use on every project.
