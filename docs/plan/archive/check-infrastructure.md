# Phase-zero code plan

Status: archived. Built in phase zero; its lasting decisions are in [tooling.md](../tooling.md).

## Reference docs and development hooks

```text
docs/reference/sources.json          Locked-package and Mise-tool documentation sources.
tools/reference-docs.ts              Read versions, validate installed packages or fetch exact Git tags, stage docs, publish copies.
.pi/tau/settings.json                Existing development-host hook schema; lint fixes before formatting, serial read-only checks.
tools/checks/reference.test.ts  Real docs command with installed packages and a local tagged Git repository.
tools/checks/hooks.test.ts      Routing table and real configured shell commands, including quoted paths and deletion.
```

```ts
type DocSource = { package: string; versionSource: "lock" | "mise";
  files: readonly string[]; origin: { kind: "installed" } |
  { kind: "git"; repository: string; tagPattern: string } };
type HookCommand = { name: string; command: string; includeGlobs: readonly string[] };
```

```text
docs task -> sources.json + bun.lock + mise.toml -> exact versions
  installed -> verify package.json version -> match requested documentation files
  git -> shallow sparse checkout of exact tag -> match requested documentation files
  copy only documentation text -> staged copies -> docs/reference/copies
tests -> same CLI, fixture manifest and local tagged repository
hooks -> existing host matches includeGlobs -> existing host passes files through shell positional arguments -> Mise tasks
tests -> literal routing expectations + documented shell substitution -> same Mise tasks
```

Hook globs use only `*` and `**`, matching the development host's grammar. Hook tests verify configuration and command behavior; live session invalidation remains host-owned. The documentation command is registered as a Fallow entry, not an unused-code exemption. Reference copies and Fallow caches are ignored. Focused macOS/Linux cases and separate type/lint memory measurements are recorded in the phase-zero verification section.

Implemented deviations from the layout below:

- `.oxlintrc.json`, not `.jsonc`: Oxlint discovers it without `-c` and accepts comments in it.
- The plugin is TypeScript (`tools/lint/*.ts`), typed with `@oxlint/plugins` 1.87.0. `oxlint/plugins-dev` exports only `RuleTester`, so it cannot type rules. The tsconfig `include` covers `tools`.
- `restricted-api.ts` builds one rule per concept (`no-env`, `no-console`, `no-fetch`, `no-spawn`, `no-effect-run`, `no-module-mock`, `no-sleep`) from one table. Layer scope comes from `.oxlintrc.json` overrides, not rule options, so each diagnostic names its concept.
- `bun:sqlite` outside `session` is a Fallow rule pack, `tools/fallow/imports.jsonc` (`banned-import`, reported as `policy-violation`).
- Fixture setup lives in `tools/checks/workspace.ts`, beside `checks.test.ts`.
- Launchers use `bunx --bun --no-install`, not `bun x ...`. They behave the same, but Fallow's script parser recognizes only `bunx` and otherwise reports `@effect/tsgo` as an unused dev dependency.
- Lint runs on explicit paths `src tools tests` with `--disable-nested-config`. Oxlint follows symlinked `node_modules` when it walks a fixture root, and the spikes carry nested configs.

## Files

```text
package.json / bun.lock             [New] Root package, exact pins, prepare patch, SDK self-reference when implemented.
mise.toml                          [Existing] Bun pin; add task facade and serial aggregate.
tsconfig.json                      [New] Strict TS, Bun types, Effect plugin; include src, tools and tests, not spikes.
.oxlintrc.jsonc                     [New] Built-in lint, clean-room plugin, layer/test overrides; no Effect Oxlint preset.
.fallowrc.jsonc                     [New] Architecture zones, explicit roots, dead-code/boundary/duplicate policy.
.gitignore                         [Existing] Add local dependencies, build outputs and tool caches.
.pi/tau/settings.json              [Existing shape on main] Development fix/check routing, not product settings.
tools/lint/tau-plugin.js            [New] Register syntax rules; typed with oxlint/plugins-dev JSDoc.
tools/lint/api-reference.js         [New] Resolve static same-file bindings; shared by API/test restrictions.
tools/lint/restricted-api.js        [New] Option-driven API allowlists by source layer and test scope.
tools/lint/no-module-let.js         [New] Top-level let, including export wrappers, in core/session.
tools/lint/no-generic-filenames.js  [New] Reject utils/helpers/misc/common source basenames.
tools/checks/checks.test.ts    [New] Actual-command check-infrastructure flow.
docs/reference/sources.json        [New] Documentation sources and version/tag mappings.
tools/reference-docs.ts            [New] Resolve locked versions and copy docs to `docs/reference/copies/`.
```

Enable JS checking for `tools/lint/` so the plugin is not an untyped gap. No layer `index.ts` placeholders; register implemented roots and test absent/present roots deliberately.

## Task boundary

| Task | Planned operation |
| --- | --- |
| `check:types` | `bun x --bun --no-install tsc --noEmit` |
| `check:lint` | `bun x --bun --no-install oxlint --type-aware` on source, tools and tests |
| `check:fmt` | Project-local Oxfmt `--check` on code and supported config files |
| `fix:lint` / `fix:fmt` | Same local tools; safe `--fix`, then `--write`, supplied file arguments only |
| `fallow:dead-code` | Project-local Fallow `dead-code --fail-on-issues`, including import boundaries |
| `fallow:dupes` | Fallow `dupes --fail-on-issues`; initial mild/50 tokens/5 lines/2 occurrences |
| `test` | `bun test ./tests`: the application's integration tests, passing with none until the application has some; live-provider tests remain a separate later suite |
| `test:checks` | `bun test ./tools/checks`, then `node --test "tools/lint/**/*.test.ts"`: check-infrastructure integration tests and lint rule unit tests |
| `check:mise` | `mise tasks validate --errors-only` |
| `check` | All read-only gates above; serial execution bounds type/lint peak memory |
| `docs` | Version-matched documentation copy; separate from checks |

`prepare`: `bun x --bun --no-install effect-tsgo patch --typescript`. Full check entry: `mise run --jobs 1 check`. Missing tools, malformed configuration, crashes and parse failures fail the task; no install or safe-looking success fallback during checks.

## Rule ownership and scope

| Policy | Owner / scope |
| --- | --- |
| Types, floating Effect, missing Effect errors/context | Patched compiler; configure blocking severities explicitly |
| Floating/misused promises and other type-aware correctness | Native Oxlint/tsgolint rules; no custom type checker |
| `Effect.runPromise` | Syntax API restriction; allowed in `src/cli` and `src/sdk` |
| Environment reads | Syntax API restriction; source reads belong in `host` |
| `console` / global `fetch` / `Bun.spawn` | Syntax API restriction; allowed source layers `cli` / `ai` / `proc` respectively |
| Module-level `let` | Syntax rule; `core` and `session`, including exported declarations |
| Generic filenames | Syntax rule; application source |
| Module mocking / sleeps | Syntax API restriction; integration tests, including Bun's `mock.module` and `Bun.sleep` |
| Models through fake provider | Flow/test wiring; do not claim a syntax rule can prove endpoint behavior |
| Module import graph | Fallow; exact layer allowlists from architecture.md, including type-only imports |

Where syntax policy owns a concept, switch off the overlapping Effect diagnostics (environment, console, fetch and run-at-edge restrictions) explicitly. Do not port the spike's duplicate compiler/Oxlint Effect reports. Dynamic/computed references that cannot be resolved statically are a documented limit, not claimed enforcement.

Fallow zones cover every `src` file and separate `tools`/`tests` from production. Same-layer imports are allowed; leaf layers cannot import another application layer. Validate package self-reference and `bun:sqlite` restriction to `session`. Public SDK exports and default exports loaded dynamically need narrow consumer/entry registrations, not blanket unused-export exemptions.

Register the syntax plugin's default export and task-only tooling through supported configuration/task discovery. Keep an added unused tool dependency detectable; do not copy `main`'s dependency or callback exemptions wholesale.

## Composition and interfaces

Production rules use Oxlint's real source/scope objects; integration fixtures inject source files and options through the same root configurations and actual CLI.

```ts
type ApiReference = { module: string; member: string };
type Restriction = { api: ApiReference; message: string };
type ResolveApi = (node: Node, scope: Scope) => ApiReference | undefined;
type CommandResult = { exitCode: number; stdout: string; stderr: string };
type RunCommand = (argv: readonly string[], cwd: string) => Promise<CommandResult>;
type DocSource = { package: string; files: readonly string[];
  origin: { kind: "installed" } | { kind: "git"; repository: string; tagPattern: string } };
type CopyReferenceDocs = (sources: readonly DocSource[], versions: ReadonlyMap<string, string>,
  destination: string) => Promise<void>;
```

`Node`/`Scope` denote Oxlint API types, not new project AST types. Normal CLI output and exit codes remain authoritative; add a reporter only if a verified tool needs one.

```mermaid
flowchart LR
    edit[Changed files] --> hooks[Development hooks]
    hooks --> fixes[Safe lint then format]
    hooks --> tasks[Named Mise checks]
    manual[Full check] --> tasks
    tasks --> native[Pinned real tools]
    fixtures[Integration fixtures] --> native
    native --> result[Exit code and diagnostics]
```

```text
select fix/check tasks by changed file kind
pass existing changed files as separate arguments to fixes
run matching whole-project checks after fixes
run types and lint serially in the full aggregate
preserve failing exit codes and actionable diagnostics
invalidate verification after later writes
```

Routing includes TS/TSX/JS sources, tests, tools, relevant root config, `package.json` and `bun.lock`; plugin edits rerun lint and its integration tests. Deletions trigger graph checks but are not fixer arguments. Markdown uses the existing formatting automation. Adding a layer updates its Fallow zone/import policy, applicable lint scope and acceptance fixtures; adding a dependency updates the lockfile and documentation source manifest.
