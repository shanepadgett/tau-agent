# Agent readiness — ecosystem packs (research draft)

Language-specific catalogs for deterministic `lint-entropy` / verify scanning. Complements general (language-agnostic) checks in `agent-readiness-extension.md`.

Status: research snapshot for pack data design. Not exhaustive. Prefer **detect what the repo already chose** over imposing a default when multiple tools compete.

Detection always starts with language signals (manifests, extensions), then tool config/deps/CI.

---

## TypeScript / JavaScript (Node-oriented)

**Detect:** `package.json`, `tsconfig*.json`, `*.ts`/`*.tsx`/`*.js`/`*.jsx`, lockfiles. If `deno.json`/`deno.jsonc` present without a Node app layout, use **Deno overlay** below instead of assuming Node tools.

| Capability | Primary detect | Acceptable alts | Agent-oriented notes |
| --- | --- | --- | --- |
| format | Prettier (`.prettierrc*`, `prettier.config.*`); Biome (`biome.json[c]`); dprint; Oxfmt (`.oxfmtrc*`) | honor existing | fix: `--write` / biome `--write`; check modes exist; oxfmt/prettier list-different |
| lint | ESLint (`eslint.config.*`, `.eslintrc*`) + typescript-eslint; Oxlint (`.oxlintrc*`, `oxlint.config.*`); Biome | | ESLint `--fix --quiet`; Oxlint `--fix --quiet --format agent\|json\|sarif` |
| types | `tsc` / `tsconfig*.json` (`--noEmit --pretty false`) | Flow only if `.flowconfig`; Oxlint `--type-check` if adopted | no general autofix |
| dead | **Fallow** (`.fallowrc.json[c]`, `fallow.toml`) | **Knip** (`knip.json*`, `package.json#knip`) if already adopted; tsc/ESLint local unused only | Fallow: unused files/exports/types/deps, class members, cycles, optional `--type-aware`. CLI: `fallow dead-code`, `fallow --only dead-code`, `--format json --quiet --fail-on-issues`, `fallow fix` for safe unused. Node/npm-oriented; not a Deno default. Knip: broader niche plugin catalog; keep if already satisfactory. |
| complexity | **Fallow health** (`fallow health`, cyclomatic/cognitive/CRAP thresholds) | ESLint `complexity` / max-*; Sonar | Fallow is the dedicated entropy health pass when present |
| dup | **Fallow dupes** (`fallow dupes`, modes strict/mild/weak/semantic) | **jscpd** (`.jscpd.json`) — Fallow docs note jscpd v5 can be faster for raw clone scan alone | Prefer one duper in verify, not both unless intentional. jscpd reporters `ai`/`json`/`sarif` |
| boundaries | **Fallow** zones/presets (layered, hexagonal, feature-sliced, …) via dead-code / `--boundary-violations` | dependency-cruiser; eslint-plugin-boundaries; import plugin; Nx module boundaries | Fallow can replace madge-ish cycle + zone checks when configured |

**Entropy suite note:** Fallow is a Rust-native **combined** dead + dupes + health + boundaries tool (migrate from knip/jscpd supported). Prefer detecting Fallow first and treating Knip+jscpd+dep-cruiser as the split stack when Fallow is absent. Fallow’s own comparison: use Knip when you need its wider plugin surface or an existing Knip setup you like; jscpd alone if you only want fastest standalone duplication.

**Ceiling:** strong across all buckets if wired. Whole-repo dead/entropy needs Fallow or Knip(+friends), not tsc alone.

**Improve default if empty:** formatter already in tree else Prettier or Biome; ESLint+typed or Oxlint; `tsc --noEmit`; **Fallow** for entropy (dead+dupes+health, boundaries if architecture warrants); only suggest bare Knip/jscpd if the repo already standardized on them or rejects Fallow.

### Deno overlay (not “TS + Knip”)

**Detect:** `deno.json` / `deno.jsonc` (primary); `deno.lock` secondary.

**Knip:** no official Deno support (still a requested feature). No Deno plugin. Built around `package.json` / npm resolution. Workarounds (`deno run -A npm:knip` + fake package.json + manual entry globs) mis-read `deno.json` imports, `npm:`, `jsr:`, and import maps — do **not** enable Knip by default for Deno. Treat whole-repo dead as weaker until a Deno-aware tool is proven on that repo.

| Capability | Primary | Notes |
| --- | --- | --- |
| format | **`deno fmt --check`** (`--fail-fast` optional) | first-party |
| lint | **`deno lint --json`** (or `--compact`) | `no-unused-vars` is local only; **exports count as used** — not unused-export detection |
| types | **`deno check --frozen <entries…>`** | entries must be explicit; `--all` if remote/npm types desired |
| dead | **partial:** deno lint locals only | `@deno/graph` for custom reachability; no Knip-class standard gate; community CLIs incomplete on jsr/npm: |
| complexity | opt-in community Deno lint plugins (e.g. jsr:@hugoalh/deno-lint-rules max-complexity) | pin versions; not core |
| dup | **jscpd** (runtime-neutral) | same as TS pack |
| boundaries | **jsr:@cunarist/deno-import-check** (cycles, alias/layer rules from deno.json) | opt-in; remote/JSR not fully traversed |

**Ceiling:** excellent native fmt/lint/check. Dead/entropy below Node+Knip. Lean on general rails + markers + import-check if adopted.

**Improve default if empty:** wire `deno fmt --check`, `deno lint`, `deno check` into verify; optional jscpd + import-check; document dead-code gap honestly.

---

## C# / .NET

**Detect:** `*.sln`, `*.csproj`, `global.json`, `Directory.Build.props`, `Directory.Packages.props`, `.config/dotnet-tools.json`.

| Capability | Primary detect | Acceptable alts | Agent-oriented notes |
| --- | --- | --- | --- |
| format | **dotnet format** (SDK; `.editorconfig`) | CSharpier (`.csharpierrc*`, tool manifest) | `dotnet format --verify-no-changes -v:q`; csharpier `check` / `format` |
| lint | SDK Roslyn analyzers + `.editorconfig`/`.globalconfig`; `EnableNETAnalyzers`, `AnalysisLevel` | Roslynator, Meziantou.Analyzer, StyleCop (legacy-leaning) | build-integrated; fixes via `dotnet format analyzers/style` |
| types/build | **`dotnet build`** (`Nullable`, `TreatWarningsAsErrors`, …) | | `dotnet build -v:q --warnaserror`; SARIF via `ErrorLog` |
| dead | IDE/CS unused (e.g. IDE0051) when enforced in build | ReSharper InspectCode; NDepend (commercial) | private/local strong; public/API dead hard |
| complexity | CA150x + `CodeMetricsConfig.txt` (opt-in) | Sonar, NDepend, VS metrics | often disabled until severity set |
| dup | **Sonar** (mainstream gate) | NDepend | **no first-party SDK clone detector** |
| boundaries | **ArchUnitNET** or NetArchTest (test projects) | NDepend | `dotnet test`; no autofix |

**Ceiling:** excellent format/lint/build. Dup and whole-program dead need extra tools. Complexity opt-in.

**Improve default if empty:** `dotnet format` verify + build warnaserror + explicit analyzer/`EnforceCodeStyleInBuild`; ArchUnit tests if layers matter; Sonar only if org already runs it.

---

## Go

**Detect:** `go.mod`, `go.work`, `*.go`, `.golangci.y*ml` / `.golangci.toml`.

| Capability | Primary detect | Acceptable alts | Agent-oriented notes |
| --- | --- | --- | --- |
| format | **gofmt** / `go fmt` | gofumpt, goimports (also via golangci formatters) | `gofmt -l` nonempty → fail (exit code alone unreliable) |
| lint | **golangci-lint** config v2 | standalone staticcheck, govet | `golangci-lint run --color=never --show-stats=false` + JSON; `--fix` where supported |
| types/build | **`go build` / `go test` / `go vet`** | | `-json`, `-mod=readonly`; honor tags/GOOS/GOARCH |
| dead | golangci `unused` / staticcheck U1000; x/tools **`deadcode`** for whole-program | | `deadcode -json`; not always safe to delete |
| complexity | gocyclo / cyclop / gocognit (often via golangci) | | one metric + threshold |
| dup | **dupl** (golangci or standalone) | | false positives possible; tune threshold |
| boundaries | language **`internal/`** packages; depguard / gomodguard; go-arch-lint (`.go-arch-lint.yml`) | | internal is strongest free boundary |

**Ceiling:** very high via golangci-lint as one aggregator. Architecture intent still needs config or `internal/`.

**Improve default if empty:** gofmt + go test/build + golangci-lint (staticcheck, unused, errcheck, ineffassign, govet) + optional deadcode for mains.

---

## Rust

**Detect:** `Cargo.toml`, `rust-toolchain.toml`, workspace members, `rustfmt.toml`, `clippy.toml`, `deny.toml`.

| Capability | Primary detect | Acceptable alts | Agent-oriented notes |
| --- | --- | --- | --- |
| format | **rustfmt** / `cargo fmt` | | `cargo fmt --all -- --check` |
| lint | **Clippy** (`clippy.toml`, `[lints.clippy]`) | | `cargo clippy --message-format=json`; `--fix`; deny warnings |
| types/build | **`cargo check`** / rustc (`[lints.rust]`) | `cargo fix` for applicable | JSON message format; `-q` |
| dead | rustc `dead_code` / `unused` groups | **cargo-machete** (unused deps); cargo-udeps (nightly) | machete `--json` |
| complexity | Clippy complexity *lints* (expressions) | rust-code-analysis-cli metrics (niche) | no dominant threshold-budget tool |
| dup | **jscpd** / cpd | | same as multi-lang |
| boundaries | **cargo-deny** (`deny.toml`) deps policy; **cargo-modules** cycles/orphans; cargo-semver-checks (public API) | | deny/modules are different “boundary” kinds; no strong layer DSL |

**Ceiling:** excellent core (fmt/clippy/check/dead_code). Dup/complexity/layering thinner than TS/Java.

**Improve default if empty:** fmt check + check + clippy deny warnings + machete; deny.toml if supply-chain matters.

---

## Odin

**Detect:** `*.odin`, `ols.json`, `odinfmt.json`, `odin` in CI/scripts.

| Capability | Primary detect | Status for scanner |
| --- | --- | --- |
| format | **odinfmt** (OLS); experimental lucyfmt | **available** if odinfmt present; weak check-only UX |
| lint | **`odin check … -vet`** (+ style `-vet-*` flags) | **available** — primary lint gate |
| types/build | **`odin check`** (`-json-errors`, `-terse-errors`, `-no-entry-point`) | **available** — mandatory when odin present |
| dead | compiler `-vet-unused*` / `-show-unused*` | **partial** — not full reachability; no field unused |
| complexity | no mature OSS standard | **na** (unless commercial act101 MCP configured) |
| dup | no mature OSS standard | **na** (unless act101) |
| boundaries | `-show-import-graph` report-only; act101 conformance commercial | **na** for policy gates in OSS baseline |

**Ceiling:** honest low on entropy. General rails (AGENTS, standards, context, markers, cold start) carry more weight. Do not fake entropy pass.

**Improve default if empty:** `odin check -vet` (+ json errors) in verify; odinfmt if OLS used; document marker/review reliance for dead/complexity.

---

## Java

**Detect:** `pom.xml`, `build.gradle*`, `mvnw`/`gradlew`, `*.java`.

| Capability | Primary detect | Acceptable alts | Agent-oriented notes |
| --- | --- | --- | --- |
| format | **Spotless** (`spotlessCheck`/`Apply`) | google-java-format, Palantir via Spotless/fmt-maven | prefer existing `check` task |
| lint | Checkstyle, **PMD**, **SpotBugs**; Error Prone if wired | Qodana/Sonar if present | SARIF/XML/report files; little autofix outside format |
| types/build | **javac** via Maven/Gradle (`failOnWarning`, `-Werror`) | NullAway, Checker Framework | wrappers `./mvnw` `./gradlew` |
| dead | PMD unused private/local; Gradle dependency-analysis plugin | Qodana unused; UCDetector niche | public dead unreliable |
| complexity | PMD Cognitive/Cyclomatic/NPath/GodClass | Sonar | |
| dup | **PMD CPD** | Sonar | CLI quiet + fail codes |
| boundaries | **ArchUnit** tests; Forbidden APIs; Maven Enforcer; jQAssistant | jdeps/JPMS | run as tests |

**Ceiling:** high if Maven/Gradle already has `verify`/`check` full of plugins. Scanner should **prefer existing aggregate gate** over inventing parallel commands.

**Improve default if empty:** Spotless + Checkstyle/PMD + compile Werror + CPD; ArchUnit when layers exist; SpotBugs after compile.

---

## Kotlin

**Detect:** Kotlin Gradle plugins, `*.kt`/`*.kts`, `detekt.yml`, ktlint/Spotless config; Android AGP if present.

| Capability | Primary detect | Acceptable alts | Agent-oriented notes |
| --- | --- | --- | --- |
| format | **ktlint** / Spotless ktlint or ktfmt | IntelliJ format CLI (heavy) | `ktlintCheck`/`Format`, `spotlessCheck`/`Apply` |
| lint | **detekt** (`detekt.yml`, baselines); Android Lint if Android | Qodana | detekt 1.23 stable frozen; 2.x alpha — pin deliberately; SARIF |
| types/build | Kotlin compiler + `./gradlew check`; `allWarningsAsErrors`; explicit API mode | ABI validation for libraries | |
| dead | compiler/ktlint/detekt narrow unused | Qodana whole-project | **no lightweight full reachability** |
| complexity | **detekt** complexity rules | | first-class in detekt.yml |
| dup | **PMD CPD** language kotlin | detekt string-literal only ≠ real dup | |
| boundaries | Gradle modules; **Konsist** (source, pre-1.0); **ArchUnit** (JVM bytecode) | detekt forbidden imports only thin | KMP: prefer Konsist/source-set deps; ArchUnit JVM-only |

**Overlap:** mixed Kotlin/Java → Spotless + ArchUnit + CPD shared; keep detekt/ktlint for Kotlin sources.

**Ceiling:** strong format/lint/complexity via ktlint+detekt. Dead code same honesty problem as Java. Watch detekt major version gap.

**Improve default if empty:** Spotless+ktlint, pinned detekt, gradlew check, CPD; Android Lint on Android; ArchUnit/Konsist if multi-module.

---

## Swift

**Detect:** `Package.swift`, `*.xcodeproj`/`*.xcworkspace`, `.swiftlint.yml`, `.swift-format`, `.swiftformat`, `.periphery.yml`.

| Capability | Primary detect | Acceptable alts | Agent-oriented notes |
| --- | --- | --- | --- |
| format | **swift-format** (`.swift-format`) or **SwiftFormat** (`.swiftformat`) | if both, report both — do not pick silently | lint/check modes; SwiftFormat `--quiet` |
| lint | **SwiftLint** (`.swiftlint.yml`) | swift-format also style-lints | `swiftlint lint --quiet --strict --reporter json\|sarif`; `--fix` |
| types/build | **`swift build`** (SwiftPM) or **xcodebuild** (schemes) | | Xcode: scheme/destination discovery hard; `-quiet` |
| dead | **Periphery** (`.periphery.yml`) | | `periphery scan --quiet --strict --format json`; needs build/index; false friends (ObjC, IB, public API) |
| complexity | SwiftLint metrics rules (cyclomatic, lengths, nesting) | Lizard (weaker Swift parse) | configure in yml |
| dup | **jscpd** (`.jscpd.json`) | | generic token tool |
| boundaries | SwiftPM/Xcode **target graph** (compile-enforced) | SolidLikeARock (`.solid.yml`, emerging) | layer policy immature |

**Ceiling:** strong format/lint/build/dead (Periphery). Architecture policy weak beyond modules. Xcode repos need scheme-aware verify, not blind `swift build`.

**Improve default if empty:** one formatter + SwiftLint strict + build gate + Periphery when macOS/CI allows; jscpd optional.

---

## Cross-cutting scanner rules

1. **Honor existing verify** — if `mise run check` / `./gradlew check` / `dotnet build` already aggregates tools, detect membership inside that gate; don't demand parallel one-offs.
2. **Applied vs possible** — missing Knip on TS = `missing`; missing full dead on Odin = `na` or `partial` ceiling.
3. **Multi-language monorepos** — union packs; subsection report per language.
4. **Commercial optional** — Sonar, Qodana, NDepend, act101: detect if configured; never require for pass on OSS baseline.
5. **Autofix honesty** — format strong; lint partial; dead/dup/architecture almost never safe bulk-fix.
6. **Quiet/json/sarif** — pack metadata should store preferred agent invocation, not only binary name.

## Suggested pack metadata shape (implementation later)

```text
language id
detect: manifests, extensions, globs
capabilities:
  format | lint | types | dead | complexity | dup | boundaries
    tools[]: name, detect[], invoke check/fix, output, maturity, notes
    unsupportedReason?  # → criterion na
```

## Sources

Synthesized from web research (official docs/READMEs/project pages, 2026). Re-verify flags when implementing packs; CLIs move.
