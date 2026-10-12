# Phase zero: check infrastructure

Status: implementation complete; acceptance coverage and remaining verification are recorded below. The Fallow blockers are resolved ([Resolved](#resolved)). No further spikes. Fallow covers dead code, boundaries and duplicates only. [tooling.md](tooling.md) holds the agreed tool choices. [The code plan](work/check-infrastructure.md) and [integration acceptance cases](work/check-acceptance.md) hold the implementation detail.

## Shape

Use Mise as the task facade, with project-local pinned tools. Add root check configuration, a clean-room syntax plugin, and integration tests that run the actual check commands. Reuse the existing development fix/check hook structure; standalone Tau's runtime check service comes later with `core`.

Pattern: direct task composition plus data-driven lint restrictions. This avoids a second check runner, a generated module map, or one special-case rule per layer.

```mermaid
flowchart LR
    human[Developer or CI] --> mise[Mise tasks]
    hooks[Development fix/check hooks] --> mise
    mise --> types[Types and Effect]
    mise --> lint[Oxlint and syntax plugin]
    mise --> format[Oxfmt]
    mise --> graph[Fallow graph and duplicates]
    mise --> tests[Bun integration tests]
```

| System | Phase-zero change | Boundary |
| --- | --- | --- |
| Package/tool installation | Add root package and lockfile; expand existing Bun pin | Frozen install, TypeScript patch in `prepare`, local launchers |
| Task facade | Expand `mise.toml` | Named check/fix tasks; aggregate full check runs serially |
| Type/lint policy | Add root TS/Oxlint config and plugin | Compiler owns types/Effect; Oxlint owns other lint |
| Architecture/dead code | Add Fallow config | Zones follow architecture.md; explicit roots, public SDK and dynamic entries |
| Development automation | Add repository settings using the existing hook structure | Selected-file safe fixes; matching whole-project checks |
| Check acceptance | Add integration flow | Real child processes against temporary projects, not mocked tools |
| Dependency reference docs | Add manifest and `docs` task | Copy version-matched docs into committed `docs/reference/copies/`; `check:reference` verifies them offline |

## Installation inventory

One owner for each executable: Bun in Mise, npm tool packages in root `devDependencies`; do not also pin different copies of those tools in Mise. Force JS launchers through Bun and disable implicit downloads when running checks.

| Dependency | Initial exact pin | Evidence |
| --- | --- | --- |
| Bun | 1.4.3 | Current `mise.toml` and spikes |
| Effect | 4.0.3 | Toolchain spike; runtime dependency |
| TypeScript / `@effect/tsgo` | 7.0.2 / 0.51.1 | Spike 6 and installed compatibility table |
| oxlint / oxlint-tsgolint | 1.87.0 / 7.0.2004 | Latest. Spike 6 avoided 7.0.2004 only for the Effect Oxlint patch, which production does not use; oxlint 1.87.0 accepts `>=7.0.2003` |
| `@types/bun` | 1.4.3 | Latest; matches Bun 1.4.3 |
| Fallow | 3.33.1 | Latest. 2.100.0 was copied from `main` without checking npm; its `dupes` never fails and its launcher could truncate output under Bun with exit 0 |
| Oxfmt | 0.72.0 | Released with oxlint 1.87.0 on 2026-10-05; 0.62.0 dates from 2026-08-03 |
| `@oxlint/plugins` | 1.87.0 | Official plugin types; no dependencies |

Check npm for the latest version before pinning a tool. Pin an older version only for a recorded reason.

Production uses `effect-tsgo patch --typescript`, not the experimental Oxlint Effect patch. Verify a clean install and a frozen reinstall both activate TypeScript and Effect diagnostics. Inspect platform launchers before treating a successful version command as proof of Bun-only operation.

## Proposed gates

Fail on type/Effect errors, lint errors, formatting differences, forbidden imports, unused code/dependencies, unresolved imports, cycles, and duplicate groups. Keep unused internal exports visible; registering a layer root must not mark every export used.

Fallow owns dead code, boundaries and duplicates only. Complexity and health checks are excluded as too noisy. Invoke explicit `dead-code` and `dupes` subcommands, not bare `fallow`, which also runs health analysis. Tests and development tools participate; generated fixture copies and reference docs are outside application analysis.

## Scope and sequencing

1. Implement root configuration and the syntax plugin directly; add acceptance cases as a Bun integration flow.
2. Verify the exact production split, Bun launchers, Fallow dead-code/boundary/duplicate gates, and formatter exit behavior through those integration tests.
3. Connect development hooks and verify their file routing, ordering and failures; add the version-matched documentation task.
4. Review exact coding-standard text separately, then start the AI-layer plan. Phase zero does not add placeholder application implementations or unused dependencies for later layers.

The existing `.pi/tau/settings.json` format is development-host configuration, not standalone Tau's `.tau/` runtime schema. Keep that distinction explicit. CI can invoke the same frozen install and full check; a new CI workflow is a separate scope decision.

## Evidence and reuse

- `[Existing]` Task and hook structure: `main:mise.toml` and `main:.pi/tau/settings.json`, inspected at `99d50f05bc8f9e7466f649663f110d398bb388df`. Port only the applicable structure, not npm/Vitest/Pi-specific policies or ignore lists.
- `[Existing]` TypeScript options and process-fixture pattern: `spikes/toolchain/tsconfig.json` and `run.ts`. Reference only; production never imports spike code. Its launchers use Node shebangs, and its benchmark included the experimental Oxlint Effect patch.
- `[New]` Syntax binding resolution belongs under `tools/lint/`; the spike's two member-name checks do not handle exported declarations, aliases or shadowing. Reuse one local resolver across these rules.
- [Oxlint JS plugin API](https://oxc.rs/docs/guide/usage/linter/js-plugins.html): lexical scope supported; TypeScript type-aware JS rules unsupported. Installed `oxlint/plugins-dev` supplies rule types.
- [anti-slop ideas](https://github.com/dmmulroy/anti-slop): review candidates, not an installed dependency or copied implementation. Extra style rules need separate selection.
- Fallow and Oxfmt behavior is verified end to end by the integration tests, not CLI inspection.

## Verification

The suite now contains 34 cases against temporary projects through the real `mise run` tasks. The initial 23-case scaffold passed with Fallow 3.33.1. Subsequent focused runs verified documentation copying, hook configuration, incompatible compiler rejection, isolated duplicate thresholds and peak memory on macOS arm64 and Linux arm64/glibc. The verified cases cover:

- One `tsc` run reports TS2322 and `floatingEffect`. Oxlint reports floating promises and not floating Effects.
- Each restricted API is reported in its forbidden layer, including import aliases, destructuring, `const` aliases and static computed keys. Aliases are reported where they are bound. Allowed layers and shadowed names stay clean.
- Module-level `let` (ordinary and exported) is reported in `core` and `session`. Generic file and folder names, module mocks and sleeps are reported.
- Fallow reports forbidden imports, type-only imports, self-reference imports, `bun:sqlite` outside `session`, files outside all zones, unused files, exports and dependencies, unused dev dependencies, unresolved imports and cycles. A project with every allowed edge, an Effect `Context.Service`/`Layer`, and an unused public SDK export passes.
- Format check, parse failure, file-scoped idempotent fixes with spaces and quotes in names, and lint fixes with the same names all behave as expected.
- The full `check` passes a clean project and fails when the last gate fails. Every task fails when tools are not installed and downloads nothing. A frozen install and reinstall both leave the patched compiler active.
- Documentation copying uses locked installed versions and exact Git tags derived from Mise pins. Missing versions, files, tags, non-documentation paths and stale installed packages fail without replacing previous copies. `mise run docs` also passed against the production manifest, copying 369 Markdown/MDX files.
- Hook configuration selects whole-project checks for source, plugin, configuration, dependency and deleted paths. Unrelated plans and spikes select none. Configured shell commands preserve spaces and quotes, omit deleted fixer arguments, run lint fixes before formatting and propagate failures. `tsconfig.json` selects type/lint/test/graph checks, not duplication.
- Incompatible native compiler versions fail the actual `prepare` command without changing the compiler binary. Duplicate tests isolate a below-token-threshold copy over five lines, a token-rich four-line copy and a token-rich five-line copy.

Linux verification: 12 focused cases passed in a disposable Linux arm64/glibc container with a fresh frozen install, Bun 1.4.3 and Mise 2026.9.11. The complete Linux suite and full Linux aggregate are not yet verified.

Peak memory, measured through `Bun.Subprocess.resourceUsage()` on 200 generated Effect modules:

| Platform | Type check | Type-aware lint |
| --- | --- | --- |
| macOS arm64 | 183.5 MiB / 117 ms | 189.0 MiB / 165 ms |
| Linux arm64/glibc container | 174.2 MiB / 3370 ms | 180.2 MiB / 214 ms |

These are bounded-fixture measurements, not a production or CI budget; the Linux type command includes cold Mise startup. The retained resource case reports its measurements only when it fails.

Not tested yet, and moved to [deferred.md](deferred.md): full Linux acceptance, dynamically loaded application default exports, exact 49/50-token duplicate boundaries, and live development-host session invalidation. Hook tests validate configuration and documented shell behavior rather than launching a live agent session. Editor integration, x64/musl, arbitrary dynamic API aliases, framework callbacks and application-scale performance remain limits from the acceptance plan.

## Resolved

1. **Duplicate gate.** Fallow 2.100.0 `dupes` exited 0 on clone groups with every gate flag. Fallow 3.33.1 `dupes --fail-on-issues` exits 1 on any clone group, so the task is unchanged after the upgrade.
2. **`effect` unused until the AI layer.** `.fallowrc.jsonc` has `ignoreDependencies: ["effect"]` with a comment. Remove it when `src/ai` lands.

Fallow 3.x moves cycles, boundaries and policy findings to `fallow architecture`. `dead-code` still reports them until Fallow 4, so `fallow:dead-code` stays one task. A Fallow 4 upgrade must add a `fallow:architecture` task; the boundary integration tests fail without it. Fallow 3.33.1 still does not recognize `bun x` in scripts, so launchers stay `bunx --bun --no-install`.

The reference-docs manifest and command, ignore additions and development-hook settings are implemented. `tools/reference-docs.ts` is registered as a Fallow entry because Fallow does not read `mise.toml`. The rework in [tooling.md](tooling.md#checks) replaced this: copies are committed, Effect's `.ts` examples are copied, and installed API files are indexed rather than copied.
