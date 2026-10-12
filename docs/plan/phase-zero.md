# Phase zero: check infrastructure

Status: collection complete; Fallow's scope is settled, and the acceptance spike needs approval before implementation. [tooling.md](tooling.md) holds the agreed tool choices. [The code plan](work/check-infrastructure.md) and [acceptance cases](work/check-acceptance.md) hold the implementation detail.

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
| Dependency reference docs | Add manifest and `docs` task | Copy version-matched docs into ignored storage; not part of check execution |

## Installation inventory

One owner for each executable: Bun in Mise, npm tool packages in root `devDependencies`; do not also pin different copies of those tools in Mise. Force JS launchers through Bun and disable implicit downloads when running checks.

| Dependency | Initial exact pin | Evidence |
| --- | --- | --- |
| Bun | 1.4.3 | Current `mise.toml` and spikes |
| Effect | 4.0.3 | Toolchain spike; runtime dependency |
| TypeScript / `@effect/tsgo` | 7.0.2 / 0.51.1 | Spike 6 and installed compatibility table |
| oxlint / oxlint-tsgolint | 1.87.0 / 7.0.2003 | Spike 6; do not substitute 7.0.2004 |
| `@types/bun` | 1.4.2 | Toolchain spike |
| Fallow | 2.100.0 | Installed CLI, schema and `main`; combined policy still needs acceptance testing |
| Oxfmt | 0.62.0 candidate | Installed CLI and `main` Mise pin; `main` package.json instead names 0.72.0 |

Production uses `effect-tsgo patch --typescript`, not the experimental Oxlint Effect patch. Verify a clean install and a frozen reinstall both activate TypeScript and Effect diagnostics. Inspect platform launchers before treating a successful version command as proof of Bun-only operation.

## Proposed gates

Fail on type/Effect errors, lint errors, formatting differences, forbidden imports, unused code/dependencies, unresolved imports, cycles, and duplicate groups. Keep unused internal exports visible; registering a layer root must not mark every export used.

Fallow owns dead code, boundaries and duplicates only. Complexity and health checks are excluded as too noisy. Invoke explicit `dead-code` and `dupes` subcommands, not bare `fallow`, which also runs health analysis. Tests and development tools participate; generated fixture copies and reference docs are outside application analysis.

## Scope and sequencing

1. Run the isolated acceptance spike for the exact production split, Bun launchers, Fallow dead-code/boundary/duplicate gates, and formatter exit behavior on macOS and Linux arm64.
2. Implement root configuration and the syntax plugin; retain acceptance cases as a Bun integration flow.
3. Connect development hooks and verify their file routing, ordering and failures; add the version-matched documentation task.
4. Review exact coding-standard text separately, then start the AI-layer plan. Phase zero does not add placeholder application implementations or unused dependencies for later layers.

The existing `.pi/tau/settings.json` format is development-host configuration, not standalone Tau's `.tau/` runtime schema. Keep that distinction explicit. CI can invoke the same frozen install and full check; a new CI workflow is a separate scope decision.

## Evidence and reuse

- `[Existing]` Task and hook structure: `main:mise.toml` and `main:.pi/tau/settings.json`, inspected at `99d50f05bc8f9e7466f649663f110d398bb388df`. Port only the applicable structure, not npm/Vitest/Pi-specific policies or ignore lists.
- `[Existing]` TypeScript options and process-fixture pattern: `spikes/toolchain/tsconfig.json` and `run.ts`. Reference only; production never imports spike code. Its launchers use Node shebangs, and its benchmark included the experimental Oxlint Effect patch.
- `[New]` Syntax binding resolution belongs under `tools/lint/`; the spike's two member-name checks do not handle exported declarations, aliases or shadowing. Reuse one local resolver across these rules.
- [Oxlint JS plugin API](https://oxc.rs/docs/guide/usage/linter/js-plugins.html): lexical scope supported; TypeScript type-aware JS rules unsupported. Installed `oxlint/plugins-dev` supplies rule types.
- [anti-slop ideas](https://github.com/dmmulroy/anti-slop): review candidates, not an installed dependency or copied implementation. Extra style rules need separate selection.
- Fallow evidence: installed 2.100.0 `config-schema`, `dead-code --help` and `dupes --help`. Oxfmt evidence: installed 0.62.0 `--help`. CLI inspection is not an end-to-end test.

## Open

- Run the isolated acceptance spike before writing root check configuration?
