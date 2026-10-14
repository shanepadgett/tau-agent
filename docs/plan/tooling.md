# Tooling and Libraries

## Checks

Anything a tool can check deterministically is a check, not a standard. Each rule has one owner.

| Check | Tool |
| --- | --- |
| Types and Effect diagnostics | `@effect/tsgo` with TypeScript 7, the only type checker. No `bun check`. Verified by spike 6 on macOS arm64. |
| Type-aware lint | oxlint type-aware (tsgolint). |
| Syntax and layer-scoped lint | Our own oxlint JS plugin in `tools/`, written clean-room. [anti-slop](https://github.com/dmmulroy/anti-slop) supplies ideas, not code. |
| Module imports per layer | fallow boundaries (for example, `bun:sqlite` only in `database`). |
| Dead code, duplication | fallow dead-code and dupes. |
| Format | oxfmt, defaults. |
| Tests | `bun test`. Application integration tests in `tests/` run under Bun (`test`). Lint rule unit tests sit beside each rule and run under Node 24 (`test:rules`). The checks are not tested on sample projects; they run on the real repository. After an agent run, hooks run each fast task only when its inputs change; compiled-binary tests run once per `/commit` through `silentCommandRunner.beforeCommit` (see [architecture.md](architecture.md#testing)). |

- **One `@effect/tsgo` run** reports type errors and Effect rules, and editors show the same results. `bun check` cannot load plugins, so keeping it would mean a second pass.
- **Installation and scaling.** Pin compatible versions and run `effect-tsgo patch --typescript` in `prepare` after installs. Check npm for the latest version before pinning a tool; pin an older one only for a recorded reason. Spike 6 verified TypeScript 7.0.2 and `@effect/tsgo` 0.51.1. Retain separate type and lint tasks: oxlint `--type-check` and its Effect patch work, but are experimental and use more memory in the tested combined variant. At 3,000 generated Effect-heavy files, full lint takes 5.33 s and about 4.5 GiB; deep schema chains perform much worse. Recheck on real code before treating these figures as a budget. Editor integration was not tested.
- **Rule ownership.** Type-aware rules come from tsgolint and `@effect/tsgo`; we only set severity. Syntax rules we want to scope to a layer or word for agents are ours, and the matching Effect diagnostic is turned off.
- **Fallow scope.** Dead code, boundaries and duplicates only. Complexity and health scores are excluded because they are too noisy. Fallow does not read `mise.toml`; it finds tools through `package.json` scripts and config files, and it recognizes `bunx` but not `bun x` (3.33.1). Use 3.33.1 or later: 2.100.0 `dupes` never exits non-zero. A Fallow 4 upgrade must add a `fallow:architecture` task, because Fallow 4 moves cycles and boundaries out of `dead-code`.
- **Layer-scoped rules** use oxlint file-glob overrides. Examples: Effect `runPromise` only in `cli` and `sdk`; `process.env` only in `host`; `console` only in `cli`; `fetch` only in `ai`; `Bun.spawn` only in `proc`; no module-level `let` in `core` and `session`; no `utils`, `helpers`, `misc`, or `common` file names. Test rules: no module mocking, no sleeps, models only through the fake provider.
- **Biome was rejected.** Its `noFloatingPromises` covers about 75% of cases by Biome's own figure, it does not infer return types from function bodies, GritQL rules are syntax-only, and it has no Effect rules.
- **Output is failures only.** A passing check prints nothing; a failing check prints only what failed. Mise's `task.quiet` drops command echoes, `RUST_LOG=error` drops Fallow's log warnings, Oxfmt runs with `--list-different`, and Bun tests run with `--only-failures`. Commands that still print banners or summaries run through `tools/report-failures.ts`, which removes them, makes paths relative, and falls back to the raw output's last lines when nothing else remains.
- **Tasks.** One mise task per check type: `check:types`, `check:lint`, `check:fmt`, `fix:lint`, `fix:fmt`, `fallow:dead-code`, `fallow:dupes`, `test`, `test:rules`. `.pi/tau/settings.json` runs fix tasks after writes and check tasks after runs, filtered by globs, as on `main`.
- **Reference docs.** `docs/reference/sources.json` lists, for each dependency and pinned tool, a summary, doc sets to copy and API files to index. `mise run docs` copies docs into `docs/reference/copies/<package>/<version>/` from `node_modules` or a Git tag or branch (commit recorded), and writes `docs/reference/copies/index.md`. The index lists each package's docs and API files; for source and type folders it links a page of modules with the first sentence of each doc comment. API files stay in `node_modules` and are read in place. Effect's `.ts` examples are copied because they are most of its teaching content. The copies are committed, so nothing needs running after a checkout. `mise run check:reference` runs in `check`, offline: every dependency and tool has a source or an `ignore` entry, copies match the pinned versions and the source entry, API paths exist, and the index is current. Agents and plans must use the index (`AGENTS.md`, `docs/standards/planning.md`). Oxlint and Oxfmt pages come from the oxc website `main` branch, which has no version tags. TypeScript has only its README: no versioned compiler-option docs exist.

## Readability rules

Decision: enforce every readability rule a syntax check can decide. Rules are clean-room, written in `tools/lint/` and unit tested beside each rule; native oxlint rules are used wherever one exists. Anti-slop is a source of ideas only. A rule is dropped only when it cannot work, not for taste. Product rules apply to `src/**`; spacing applies to `src/**`, `tools/**` and `tests/**`.

| Group | Rule | Owner |
| --- | --- | --- |
| Evidence | no chained `as`; `// SAFETY:` comment above every non-const `as`; no object-literal assertions | `tau/no-chained-assertions`, `tau/require-assertion-justification`, `typescript/consistent-type-assertions` |
| Evidence | no `unknown`, `object` or `{}` parameters (type guards and `cause` excepted); no `unknown` returns or aliases; no open dictionaries (constraints excepted); no `Reflect.get/apply`; no ad hoc `typeof` (guards and `=== "undefined"` excepted) | `tau/no-unknown-parameters`, `no-object-parameters`, `no-unknown-returns`, `no-unknown-type-aliases`, `no-unsafe-dictionary-types`, `no-reflect`, `no-runtime-typeof` |
| Evidence | no `any`, non-null assertions, unnecessary assertions or conditions, `any` leaking through `no-unsafe-*`, `@ts-` comments | native `typescript/*` |
| Flow | no filter-then-map (lazy iterators allowed); no `...(cond ? {} : {x})`; no `reduce` beyond simple arithmetic; no `forEach`; no accumulating spread | `tau/no-array-filter-map`, `tau/no-conditional-empty-spread`, native `unicorn/*`, `oxc/*` |
| Flow | no nested ternary, negated condition, `else` after `return`, lonely `if`, parameter reassignment; depth ≤ 3, parameters ≤ 4, function ≤ 60 lines | native |
| Naming | names of two or more characters (single capitals allowed for generics); no magic numbers other than -1, 0, 1, 2; no `utils`/`helpers` files | native `id-length`, `no-magic-numbers`; `tau/no-generic-filenames` |
| Modules | no module that only re-exports other modules; import each name from the module that defines it | `tau/no-reexport-only-modules` |
| Evidence | no `in` key probes (type guards excepted); no `const x: unknown = ...` asserted back with `as` | `tau/no-in-operator`, `tau/no-widen-then-assert` |
| Parameters | no boolean parameters; take a named option or split the function; no optional (`?`) parameters | `tau/no-boolean-parameters`, `tau/no-optional-parameters` |
| Naming | no `data`, `temp`, `result`, `obj` and similar names on variables and parameters (destructured names exempt) | `tau/no-vague-identifiers` |
| Comments | no short line comments that restate the next line (`// Import x`, `// Return the result`); no commented-out code; no comments that point at plans, standards, spikes or ticket numbers; no JSDoc that only repeats the name; every `src/` file opens with a doc comment of at most 200 characters, no tags, that does not just repeat the file name, then a blank line | `tau/no-narration-comments`, `tau/no-commented-code`, `tau/no-internal-references`, `tau/no-restating-jsdoc`, `tau/require-file-doc` |
| Effect | no `Effect.serviceOption`; no catch handlers that drop the error and succeed with nothing; no `Effect.gen` without a `yield*`; no `_tag` reads or hand-built `_tag` objects (modules that import Effect only, `Match.when/not` patterns excepted) | `tau/no-service-option`, `tau/no-silent-error-swallow`, `tau/no-yieldless-gen`, `tau/no-tag-access`, `tau/no-manual-tagged-construction` |
| Effect | a function whose whole body is `Effect.gen(...)` and that takes parameters uses `Effect.fn("name")`; an error built in a `catch`, `Effect.try`/`tryPromise` `catch` handler or `Effect.mapError` keeps the original as `cause` | `tau/prefer-effect-fn`, `tau/error-needs-cause` |
| Spacing | a multiline statement is separated from its neighbours by a blank line; guard clauses and short bindings stay grouped; overloads and imports are exempt; autofix | `tau/require-readable-spacing` |

- **Effect rules mostly belong to the compiler.** `@effect/tsgo` already ships diagnostics for most of oxslop's Effect rules, written for Effect 4: `tryCatchInEffectGen`, `unnecessaryEffectGen`, `multipleEffectProvide`, `strictEffectProvide`, `layerMergeAllWithDependencies`, `schemaStructWithTag`, `catchUnfailableEffect`, `outdatedApi`. These are `error` in `tsconfig.json`, and `asyncFunction` and `newPromise` are also `error` for `src/**` only through a per-file override, because `tools/` and `tests/` use `async` freely. `asyncFunction` flags `Effect.tryPromise(async () => ...)` as well, so Promise interop is written as `Effect.tryPromise(() => promise)`. `effectFnOpportunity` never reports under `tsc`, even at `error`; `tau/prefer-effect-fn` replaces it. `strictEffectProvide` stays off: it cannot be scoped to entry points, so it flags the one legitimate `Effect.provide` in `cli`. Our lint rules cover only what the compiler does not.
- **Not carried over from oxslop:** `no-disable-validation` (the option no longer exists in Effect 4), `prefer-option-from-nullable` (renamed `Option.fromNullishOr`; add if `src/` shows the pattern), `no-switch`/`no-try-catch` as lint (conflicts with `switch-exhaustiveness-check`; the compiler covers try/catch in generators), `no-comments`, `pipe-max-arguments`, `no-known-value-widening`.
- **From the main-branch anti-slop doc.** Built: `error-needs-cause`, `no-commented-code`, `no-restating-jsdoc` and `no-internal-references`. `no-reduce-copy` is covered by `unicorn/no-array-reduce` and `oxc/no-accumulating-spread`. `timer-needs-named-constant` and `unit-in-policy-names` wait for real cases, since `Duration` carries its unit and `restricted-api` bans raw timers. Its layer, island, route, Fresh and live-region rules do not apply; fallow boundaries own layer imports.
- **Not built yet:** `shape` in names, and rules for "why, not what" comments beyond narration.
- **Spacing and the formatter.** A dry run of anti-slop's spacing rule found no conflict with `oxfmt`; ours is narrower and the integration test checks that `fix:lint` output passes `check:fmt`.
- **Conditional spreads under `exactOptionalPropertyTypes`.** The rule pushes toward `T | undefined` fields or step-by-step construction. Revisit if `src/` fights it.
- **Thresholds** (depth, parameters, function length, magic-number allowlist) live in `.oxlintrc.json`. Revisit with real code.
- **Complexity metrics stay out** of fallow; the caps above are lint syntax checks.

## Live model matrix

The models every live check runs on. Together they cover each route Tau ships, each protocol, and each model family that handles tool calls or reasoning in its own way. Run the matrix after a change to the tools, the agent loop, a protocol or a route: `bun spikes/live-models/check.ts` (see its `NOTES.md`). Change this table when a newer model replaces one; keep one model per reason.

| Route | Model | Covers |
| --- | --- | --- |
| `chatgpt` | `gpt-6-luna`, `gpt-6.1-sol` | Sign in with ChatGPT; OpenAI's two current models |
| `codex` | `gpt-6-luna`, `gpt-6.1-sol` | the same models through the Codex server |
| `anthropic` | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` | the Claude subscription; the three current Claude sizes |
| `opencode-go` | `deepseek-v4.1-flash` | Chat Completions, with reasoning sent back in `reasoning_content` |
| `opencode-go` | `kimi-k3` | Chat Completions; a second popular family for agent work |
| `opencode-go` | `muse-spark-1.3-contributor` | Responses from a model that is not OpenAI's |
| `opencode-go` | `minimax-m3` | Messages from a model that is not Claude |
| `openrouter` | `google/gemini-3.8-flash` | the OpenRouter protocol; the only Google model |

The `openai` route (API key) is left out: it is paid per token, and the `chatgpt` route sends the same protocol to the same models.

Each model runs the same prompts, one session, in a fresh git repository: tools (`sh`, `read`), file edits, fixing a failed script, finding and using a project skill, and following a subfolder's `AGENTS.md`. Every prompt after the first is a follow-up, so each also checks that reasoning goes back to the provider correctly and that the prompt cache is read. Results are graded from the saved session entries and files, not from what the model says it did. Whether a model fixes a script with edits or sends it again is reported, not graded.

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
| `[Library]` | Dependency module and function that provide the capability, found in `docs/reference/copies/index.md`. |
| `[New]` | Owning concept, where existing code and the dependency reference were searched, and why a new helper is needed. |

RepoReuse (arXiv 2609.35357) reported duplicated logic in 50.8% of agent task chains by turn 5. No study yet shows that an index or reuse prompt cuts duplication; fallow's duplication check does not establish semantic equivalence. Revisit a generated map only when missed discovery shows a need.

Maintenance cost could be measured per change: tokens spent, files revisited and time spent verifying. Rising numbers would show the code getting harder to change.

## Standards to write

- Adding a layer: folder, fallow boundaries and entry, the import rule in architecture.md. Written in the scaffolding plan.
