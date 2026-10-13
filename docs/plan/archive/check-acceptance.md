# Phase-zero acceptance

Status: archived. Built in phase zero, then removed; see [phase-zero.md](phase-zero.md) and [tooling.md](../tooling.md).

## Fixture isolation

`[Existing]` Reference `spikes/toolchain/run.ts`'s isolated-project/process pattern; do not import it into production or reuse its Node-dependent timing wrapper. Integration fixtures are real temporary projects outside application `src/`. Materialize them where explicit lint paths are discovered: spike 6 found Oxlint skipped ignored `.work` sources. Assert discovery before asserting rule coverage; do not bypass ignore handling to claim a pass.

## Retained flow

```ts
type Expected = { exitCode: number; diagnostics: readonly string[] };
type Case = { name: string; files: Readonly<Record<string, string>>;
  command: readonly string[]; expected: Expected };
type RunCase = (test: Case, workspace: string) => Promise<void>;
```

Fixture creation/cleanup and command execution belong beside `tools/checks/checks.test.ts`. Use real tools and real temporary projects; no mocked modules, sleeps or model requests. Production configs and rules are the inputs to retained cases, not rewritten test-only approximations.

```text
create isolated workspace
materialize the case and production configuration
resolve the pinned local tool
run the command and await completion
assert exit code and expected diagnostic identifiers
assert allowed controls remain clean
remove the workspace in finally
```

## Required cases

| Boundary | Failing case | Passing control |
| --- | --- | --- |
| Installation | Missing or incompatible patch/tool version | Fresh frozen install and frozen reinstall; Bun-forced launchers |
| Compiler | TS2322 and floating Effect in one file, both reported in one invocation | Valid typed Effect flow |
| Rule ownership | Error reported by the wrong/duplicate checker | Compiler owns Effect; unpatched Oxlint owns promise and syntax rules |
| Layer API policy | Direct, aliased, destructured and static computed forbidden reference | Allowed layer; a shadowed unrelated local identifier |
| Module state | Ordinary and exported top-level `let` in core/session | Function-local `let`; permitted host state |
| Names/tests | Generic filename, Bun/aliased module mock, sleep | Concept-owned filename; injected real dependency and awaited event |
| Import boundaries | Forbidden regular/type import, self-reference bypass, SQLite outside session | Same-layer and every allowed cross-layer edge |
| Zone coverage | New source folder outside all zones | Registered application layer |
| Dead code | Unreachable internal file/export/dependency and unresolved/cyclic import | Reachable service; intentional public SDK export; specific dynamically loaded default |
| Duplication | Two qualifying code copies; token/line boundary cases | Below-threshold pair; shared implementation; fixture copies excluded narrowly |
| Format | Unformatted supported file and syntax/formatter error | Clean file; safe fixes are idempotent |
| Routing | Plugin/config/dependency edit or deletion fails to select required check | Correct selection; unrelated docs do not run expensive TS analysis |
| File arguments | Spaces, quotes and deleted paths mishandled | Separate existing-file arguments; fixes stay file-scoped |
| Full aggregate | Any tool fails but aggregate reports success | All gates pass in serial; spawned failure and missing executable propagate |

Module graph tests distinguish public SDK roots from internal layer barrels. Exercise real Effect `Context.Service`/`Layer` reachability and default-export registrations before relying on Fallow's unused-export result.

Include a reachable Oxlint plugin and a dependency used only by a Mise task, then add an unused tool dependency and require failure. Documentation-copy cases resolve installed and Git sources at locked versions and fail on a missing version or missing requested docs.

## Completion criteria

- All positive and negative cases pass on macOS and Linux arm64 with the exact production split and Bun launch policy.
- Every blocking policy has a negative case, an allowed control and one reporting owner.
- Fallow dead-code, boundary and duplicate failures are proved by exit-code tests; report-only success must not replace a blocking check.
- Formatter supports the selected file extensions; malformed input is distinct from ordinary formatting differences.
- Measure separate type and lint commands on a bounded realistic fixture shape; record peak memory before promising a CI budget. Spike 6's exact production split was not timed.
- Record scaffold verification and untested cases in docs/plan/phase-zero.md.

Remaining limits to record: editor integration, x64/musl, arbitrary dynamic API aliases, framework callback reachability, and real application-scale performance. A check failure stops implementation for a proposed repair and approval; it does not justify a suppression or weaker setting.
