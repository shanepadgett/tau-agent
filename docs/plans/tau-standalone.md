# Tau Standalone App

Status: architecture draft. Decisions open at the end.

## Goal

Tau installs and runs as its own app: its own executable, global directory, project directory, login, sessions, installed packages, and update channel. It runs side by side with Pi on the same machine and never reads or writes Pi's state. The move from "Pi package" to "app" is a clean cutover with no compatibility layer.

Tau keeps Pi as its engine and keeps Pi's extension API, so third-party Pi packages still install into Tau. Tau does not fork Pi's source.

## Where Pi's identity comes from

Pi reads its identity once, when its `config` module loads. It walks up from that module's own file to the nearest `package.json` (`findNodePackageDir`). In a Bun binary, it uses the `package.json` next to the executable. From that file it takes:

| Field | Drives |
| --- | --- |
| `piConfig.name` | `APP_NAME`: process title, banner, `<NAME>_CODING_AGENT_DIR` and `<NAME>_CODING_AGENT_SESSION_DIR` env names |
| `piConfig.configDir` | `CONFIG_DIR_NAME`: `~/<dir>/agent` and project `<dir>/` |
| `name` | `PACKAGE_NAME`: self-update target |
| `version` | `VERSION`: banner, update checks |

Everything Pi stores follows the global agent dir: `settings.json`, `auth.json`, `sessions/`, `models.json`, `trust.json`, keybindings, and installed packages (`npm/`, `git/`). Project resources follow the project dir: `extensions/`, `skills/`, `prompts/`, `mcp.json`, and `settings.json`.

Consequence: if Pi is installed as an ordinary dependency, it finds its own `package.json` and runs as `pi` in `~/.pi`. **Tau must physically contain Pi's code** so the walk-up finds Tau's `package.json`.

Rejected alternatives:

- `PI_PACKAGE_DIR` pointed at Tau also moves Pi's theme, asset, and export-template lookups, which breaks them.
- `PI_CODING_AGENT_DIR` only moves the global dir. The project dir stays `.pi/` and the name stays `pi`.
- A hard fork (oh-my-pi's route) means maintaining all of Pi.

## Separation surface

### Follows Tau's identity automatically

| Surface | Pi | Tau |
| --- | --- | --- |
| Executable | `pi` | `tau` (package `bin`) |
| Global dir | `~/.pi/agent` | `~/.tau/agent` |
| Project dir | `.pi/` | `.tau/` |
| Login | `~/.pi/agent/auth.json` | `~/.tau/agent/auth.json` |
| Sessions, trust, models, keybindings, packages | under `~/.pi/agent` | under `~/.tau/agent` |
| Dir env overrides | `PI_CODING_AGENT_DIR` | `TAU_CODING_AGENT_DIR` |
| Process title, banner | `pi` / `π` | `tau` |
| Self-update target | Pi package | Tau package |
| First-time setup wizard | runs | skipped (Pi gates it on official distribution) |

Provider logins (Anthropic, OpenAI Codex, Copilot, Gemini) work unchanged. They use the vendors' client IDs and localhost callbacks, not Pi's identity.

### Hardcoded in Pi 1.1.0 (not affected by `piConfig`)

| Item | Effect under Tau | Handling |
| --- | --- | --- |
| Install telemetry to `pi.dev/api/report-install` (on by default) | Reports Tau's version to Pi | Tau entry sets `PI_TELEMETRY=0` |
| Version check at `pi.dev/api/latest-version` | Compares Tau's version with Pi's | Tau entry sets `PI_SKIP_VERSION_CHECK=1`. Tau checks npm itself. |
| Provider attribution headers (OpenRouter `pi`, NVIDIA `Pi`, Cloudflare, opencode client `pi`) | Tau traffic is credited to Pi | Gated by telemetry, so off with `PI_TELEMETRY=0`. The opencode header is ungated. |
| `User-Agent: pi/<version>` on catalog and installer requests | Tau identifies as Pi | Upstream |
| Model catalog refresh from `pi.dev` | Tau depends on Pi's catalog service | Keep (read-only metadata) or run with `PI_OFFLINE`. Decision. |
| MCP OAuth client metadata at `pi.dev/oauth` | Tau presents itself to MCP servers as Pi's client | Upstream. Needs a Tau-hosted metadata URL. |
| Share viewer `pi.dev/session/` | Shared sessions open in Pi's viewer | `PI_SHARE_VIEWER_URL`, or leave as is |
| Env names `PI_OFFLINE`, `PI_TELEMETRY`, `PI_TIMING`, … | A user's `PI_*` shell env affects both apps | Upstream |
| Child env `PI_CODING_AGENT=true`, `AI_AGENT=pi` | Tools see "pi" | Upstream |
| Default system prompt ("operating inside pi", Pi docs paths) | Model-visible | Tau's `soul` extension already replaces it. The docs path now resolves to Tau's package `docs/`. |

The env flags Tau sets are inherited by child processes. If a user runs `pi` from Tau's bash tool, that `pi` runs with telemetry off. That is acceptable.

### Shared on purpose

`AGENTS.md`, `CLAUDE.md`, and `~/.agents/skills` are conventions shared across tools, not Pi state.

## Architecture

```text
packages/
  agent/   private workspace: extensions, shared, src, prompts, skills, themes, docs (Tau source)
  tui/     @shanepadgett/tau-tui (decision: keep publishing or make private)
  cli/     published app package; must not contain a src/ dir (see below)
    package.json   bin: tau, piConfig { name: "tau", configDir: ".tau" }, files: dist/, docs/
    entry/cli.ts   production entry
    entry/dev.ts   development entry
    entry/env.ts   side-effect module: PI_TELEMETRY, PI_SKIP_VERSION_CHECK
    entry/registry.ts  InlineExtension[] for every Tau extension
    scripts/build.ts   esbuild bundle + asset copy
    dist/bundle/…              bundled Pi + Tau
    dist/modes/interactive/theme, dist/modes/interactive/assets, dist/core/export-html   Pi assets
```

`packages/cli` must not contain `src/`. Pi resolves assets as `<packageDir>/src/...` when a `src/` dir exists, and as `<packageDir>/dist/...` otherwise.

### Build

esbuild bundles `entry/cli.ts` together with `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui`, and all Tau extensions into `dist/bundle/`. This mirrors Pi's own `dist/bundle`. It defines `PI_BUNDLED_NODE=true` so third-party extensions get Pi's APIs from the bundled copy through Pi's virtual modules. WASM and native dependencies (`@ast-grep/wasm`, `web-tree-sitter`, `@vscode/tree-sitter-wasm`, photon, quickjs) stay external runtime dependencies of `packages/cli`. Pi's assets are copied to the paths listed above.

### Production path

```text
tau → dist/bundle/cli.js
  import "./env.ts"               // runs before Pi's config module evaluates
  setupCli()                      // Pi's CLI setup; not exported, so alias the internal module at build time (upstream: export it)
  main(argv, { extensionFactories: tauExtensions })

registry.ts
  export const tauExtensions: InlineExtension[] = [
    { name: "explore", factory: explore, builtin: true },
    …
  ]
```

`builtin: true` makes each Tau extension disableable as `-builtin:<name>` in settings and listed by `tau config`. `main()` passes factories to package commands, so `tau install npm:<pi-package>` works and installs into `~/.tau/agent`.

### Development path

```text
mise run dev → dist/bundle/dev.js (same Pi bundle, Tau identity, no factories)
  main(["-e", "packages/agent/extensions/<name>/index.ts", …, ...argv])
```

Development loads extensions from source through Pi's jiti loader, so `/reload` keeps working. Production factories are plain module imports and cannot reload. The two paths differ only in how extensions are injected. The repo's project `.tau/settings.json` must not list source extensions. Otherwise an installed `tau` run in this repo would load them twice.

## First-launch transfer from Pi

Tau never reads Pi's state on its own. On first launch, if Pi's global dir exists, Tau offers to copy selected items. The user chooses. Nothing is moved or changed in Pi's dir.

### Detection

- Run in the Tau entry before `main()` loads settings and auth. Copying after a session starts would need a reload because Pi has already read `auth.json` and `settings.json`.
- Trigger when stdin and stdout are a TTY, `~/.tau/agent` has no transfer record, and Pi's dir (`PI_CODING_AGENT_DIR` or `~/.pi/agent`) exists.
- Record the outcome (`transferred`, `declined`) in `~/.tau/agent` so the prompt never repeats. Print mode, RPC mode, and non-TTY runs skip the prompt and do not record anything.
- `tau import-pi` reruns the transfer on demand, including after a decline.

### Transferable items

| Item | Source | Handling |
| --- | --- | --- |
| Logins | `auth.json` | Copy. Overwrite only if Tau has none. |
| Pi settings | `settings.json` | Copy, minus the `packages` entry for `@shanepadgett/tau-agent`, which would load Tau twice |
| Tau settings | `tau/settings.json` | Copy to Tau's settings location (decision 2) |
| Custom models | `models.json` | Copy |
| Keybindings | `keybindings.json` | Copy |
| Trusted projects | `trust.json` | Copy |
| Global MCP servers | `mcp.json` | Copy |
| User resources | `extensions/`, `skills/`, `prompts/`, `themes/` | Copy |
| Installed packages | `packages` in `settings.json` | Reinstall through Tau's package manager; do not copy `npm/` or `git/` |
| Sessions | `sessions/` | Optional; copying can be large. Decision 7. |

Caches (`models-store.json`, `mcp-tools-cache.json`, `cache-diagnostics/`) and logs are skipped.

### Flow

```text
tau (first launch)
  detect Pi dir → show checklist (defaults: everything except sessions)
  copy selected items into a temporary dir under ~/.tau/agent, then rename into place
  reinstall selected packages
  write transfer record → main()
```

A failed copy leaves no partial files and no transfer record, so the next launch offers again.

Project `.pi/` dirs are per-repo and are not part of first launch. `tau import-pi --project` copies `.pi/contexts`, `.pi/extensions`, `.pi/prompts`, `.pi/skills`, `.pi/mcp.json`, `.pi/settings.json`, and `.pi/tau/` into `.tau/`.

The prompt runs before the TUI starts, so it is a plain terminal prompt, not a Pi TUI component. Decision 8.

## Tau code changes required

- **Hardcoded paths.** Replace `.pi` and `~/.pi/agent` with Pi's exported `CONFIG_DIR_NAME` and `getAgentDir()`:
  - `shared/settings/paths.ts` (its own `".pi"` const)
  - `shared/jsonl-store.ts`
  - `extensions/context/definitions.ts`
  - `extensions/context/index.ts`
  - `extensions/footer/index.ts` (`homedir()/.pi/agent/sessions`)
  - `extensions/ready/index.ts`
  - `extensions/ready/scan.ts`
- **Bundling breakers:**
  - `shared/settings/specs.ts` finds settings modules with a file glob and dynamic import. Replace it with a static registry. This also feeds `generate-tau-schema.ts`.
  - `tau-help` reads `help.md` and `docs/` relative to `import.meta.url`. Resolve them from `getPackageDir()` and copy the files into the package.
  - `src/ast/grammars/manifest.ts` resolves WASM paths through `import.meta.url` and `createRequire`.
  - `extensions/appshot/native-helper.ts` and `extensions/review/session.ts` use paths relative to `import.meta.url`.
- **Module state.** Pi loads file extensions through jiti with `moduleCache: false`, so each extension likely gets its own copy of `shared/`. Bundled factories share one copy. Audit module-level state. The only shared map found so far is `writeQueues` in `shared/settings/json.ts`, and sharing it is beneficial.
- **`/tau doctor`:** remove the Pi version check.
- **Updates:** add a Tau update notice that checks the npm registry, replacing Pi's version check.

## Repository changes

- Move `.pi/` to `.tau/`: contexts, extensions (dev tooling), prompts, tau settings, `npm/`, `git/`.
- Update `AGENTS.md`, `docs/`, `mise.toml`, `.fallowrc.jsonc`, `package.json` scripts (`fallow:pi-scope`), and `tsconfig.json` includes. Rewrite `check-package-sources.ts` for one package.
- Remove the root and `packages/agent` `pi` manifests and the `pi-package` keyword.
- Rewrite both READMEs' install sections and the Pi pin-alignment rule in `AGENTS.md`.
- Update the publish dev extension for `packages/cli`.

## Pi upgrades

1. Bump the exact Pi pins.
2. Rebuild.
3. Run an identity audit script that scans the bundle for `pi.dev`, attribution strings, and `process.env.PI_*` names, and diffs them against a recorded allowlist. Each new hardcode Pi adds shows up as a diff to handle.
4. Release one artifact.

## Distribution phases

1. **npm global** (`npm i -g <package>`, Node ≥22.19).
2. **Bun binary** with a `curl` installer and Homebrew, so users don't need Node. This needs:
   - `bun build --compile` of the entry, with `package.json`, `theme/`, `assets/`, `export-html/`, and `docs/` next to the executable (Pi's `build:binary` layout)
   - embedded WASM
   - a fix for `script-runner`, which uses `process.execPath` as `node`
   - per-platform signing

## Upstream requests to Pi

- Export a CLI runner (`setupCli` + `main`). `configureHttpDispatcher` is not exported today.
- Derive env names, `pi.dev` URLs, attribution headers, `User-Agent`, and `AI_AGENT` from `piConfig`. Pi already derives the agent-dir env name from `piConfig.name` and gates first-time setup on official distribution.
- Make the MCP OAuth client metadata URL configurable.

## Implementation order

Each step leaves the repo green.

1. Path hygiene and a static settings registry. This still runs under Pi.
2. Add `packages/cli` with the build, both entries, the registry, and `env.ts`. `tau` runs locally with its own identity.
3. Move the repo from `.pi/` to `.tau/` and update tooling and docs.
4. First-launch transfer and `tau import-pi`.
5. Publish cutover: new package, READMEs, `pi` manifests removed, old package retired.
6. Bun binary (later).

## Open decisions

1. **Package name** for the app, and how to retire `@shanepadgett/tau-agent`: a final release with a "Tau is now standalone" notice plus `npm deprecate`, or deprecate only.
2. **Tau settings file location**, now that the whole dir is Tau's. Keep `~/.tau/agent/tau/settings.json` and `.tau/tau/settings.json`, or flatten to `tau.json`.
3. **Pi catalog service:** keep `pi.dev` model catalog refreshes, or run offline.
4. **Third-party Pi packages:** keep `tau install npm:<pi-package>` support. Recommended: yes.
5. **`@shanepadgett/tau-tui`:** keep publishing it for extension authors, or make it private.
6. ~~Data import~~ Agreed: first-launch transfer offer plus `tau import-pi` (see First-launch transfer from Pi).
7. **Sessions in the transfer:** offer them (off by default), or leave them out.
8. **Transfer prompt UI:** plain terminal prompt before `main()`, or start Pi's TUI first and run the transfer from a Tau extension followed by a reload.
