# Tooling and Libraries

## Checks

Anything a tool can check deterministically is a check, not a standard. Each rule has one owner.

| Check | Tool |
| --- | --- |
| Types and Effect diagnostics | `@effect/tsgo` with TypeScript 7, the only type checker. No `bun check`. Verified by spike 6 on macOS arm64. |
| Type-aware lint | oxlint type-aware (tsgolint). |
| Syntax and layer-scoped lint | Our own oxlint JS plugin in `tools/`, written clean-room. [anti-slop](https://github.com/dmmulroy/anti-slop) supplies ideas, not code. |
| Module imports per layer | fallow boundaries (for example, `bun:sqlite` only in `session`). |
| Dead code, duplication | fallow dead-code and dupes. |
| Format | oxfmt, defaults. |
| Tests | `bun test`. |

- **One `@effect/tsgo` run** reports type errors and Effect rules, and editors show the same results. `bun check` cannot load plugins, so keeping it would mean a second pass.
- **Installation and scaling.** Pin compatible versions and run `effect-tsgo patch --typescript` in `prepare` after installs. Spike 6 verified TypeScript 7.0.2 and `@effect/tsgo` 0.51.1. Retain separate type and lint tasks: oxlint `--type-check` and its Effect patch work, but are experimental and use more memory in the tested combined variant. At 3,000 generated Effect-heavy files, full lint takes 5.33 s and about 4.5 GiB; deep schema chains perform much worse. Recheck on real code before treating these figures as a budget. Editor integration was not tested.
- **Rule ownership.** Type-aware rules come from tsgolint and `@effect/tsgo`; we only set severity. Syntax rules we want to scope to a layer or word for agents are ours, and the matching Effect diagnostic is turned off.
- **Fallow scope.** Dead code, boundaries and duplicates only. Complexity and health scores are excluded because they are too noisy.
- **Layer-scoped rules** use oxlint file-glob overrides. Examples: Effect `runPromise` only in `cli` and `sdk`; `process.env` only in `host`; `console` only in `cli`; `fetch` only in `ai`; `Bun.spawn` only in `proc`; no module-level `let` in `core` and `session`; no `utils`, `helpers`, `misc`, or `common` file names. Test rules: no module mocking, no sleeps, models only through the fake provider.
- **Biome was rejected.** Its `noFloatingPromises` covers about 75% of cases by Biome's own figure, it does not infer return types from function bodies, GritQL rules are syntax-only, and it has no Effect rules.
- **Tasks.** One mise task per check type: `check:types`, `check:lint`, `check:fmt`, `fix:lint`, `fix:fmt`, `fallow:dead-code`, `fallow:dupes`, `test`. `.pi/tau/settings.json` runs fix tasks after writes and check tasks after runs, filtered by globs, as on `main`.
- **Reference docs.** `mise run docs` reads `docs/reference/sources.json`, takes versions from `bun.lock` and `mise.toml`, and copies each dependency's docs (not source) at the matching git tag, or from `node_modules` when the package ships them. The copies are gitignored; `sources.json` is committed.

## Libraries

Preference order: Bun built-in, then an Effect module, then a small vetted package.

- **Bun built-ins:** `bun:sqlite`, `Bun.Glob`, `Bun.stringWidth`, `Bun.semver`, `Bun.randomUUIDv7`, `Bun.Terminal`.
- **Effect replaces** zod (Schema), retry libraries (Schedule), event emitters (PubSub, Stream), and config loaders (Config).
- **Shell parsing:** unbash, as `main` uses it for tool approval.
- **No diff library.** The agent edits through scripts and no diffs are shown.
- **MCP** is in scope, through the official TypeScript SDK. Confirm the package name at install.
- **File finding:** use published, unpatched `@ff-labs/fff-bun`, pinned. Spike 7 verifies 0.11.0 in compiled binaries on macOS and Linux arm64/glibc, with one cached native extraction rather than per-load copies. It wins initial indexing and large-tree memory, handles all tested typos, and includes a watcher; fuzzysort wins warm queries. A native prototype fixes stock FFF's intermittent ranking omission by preserving score/time priority, then breaking ties by shorter path and lexical order. The 20 targets keep consistent top-ten ranks in the tested runs. Try the published package first; reconsider the native workaround if a ranking bug is opened. See [RANKING.md](../../spikes/file-finder/RANKING.md) for costs and limits. Linux compilation needs `--define FFF_LIBC='"gnu"'`.

## Helper reuse

Plans name the reuse decision for each helper; helpers live beside the concept they serve. Use the planned fallow duplication check, not a separate generated module map.

| Plan label | Required detail |
| --- | --- |
| `[Existing]` | Existing symbol and file path to reuse. |
| `[New]` | Owning concept, where existing code was searched, and why a new helper is needed. |

RepoReuse (arXiv 2609.35357) reported duplicated logic in 50.8% of agent task chains by turn 5. No study yet shows that an index or reuse prompt cuts duplication; fallow's duplication check does not establish semantic equivalence. Revisit a generated map only when missed discovery shows a need.

## Standards to write

- Adding a layer: folder, `index.ts`, fallow boundaries and entry, the import rule in architecture.md. Written in the scaffolding plan.
- `docs/standards/code.md`: readable code, based on research, including the agreed helper-reuse approach. Written after that research.
