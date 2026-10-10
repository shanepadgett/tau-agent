# Tau Standalone App

Status: architecture agreed. Open: decisions 16–19.

## Goal

Tau installs and runs as its own app: its own executable, global directory, project directory, login, sessions, installed packages, and update channel. It runs side by side with Pi on the same machine and never reads or writes Pi's state. The move from "Pi package" to "app" is a clean cutover with no compatibility layer.

Tau is a tracking fork of Pi. Pi's source lives in this repo with a small, documented Tau change set that is re-applied on each upstream release. Tau features stay extensions. Extension and package authors get one SDK package, versioned with Tau.

## Fork model (agreed)

- Pi's source is pulled into this repo with `git subtree` from `github.com/earendil-works/pi` at a release tag. An `upstream` remote tracks new releases.
- Pi's package names stay unchanged inside the fork (`@earendil-works/pi-*`). Renaming them, as oh-my-pi did, would make every upstream file conflict on imports.
- The Tau change set inside Pi's source stays small and is listed with reasons in `docs/standards/pi-fork.md`. Every change to Pi's source goes through that list.
- Tau's changes to Pi are additive where possible, so Pi packages keep running on Tau.
- Tau does not publish Pi's packages. The app bundles them, and the SDK republishes their types.

### Change set in Pi's source

| Change | Where | Why |
| --- | --- | --- |
| Identity: name `tau`, config dir `.tau`, package `@shanepadgett/tau`, Tau's version | Pi's `config` module, injected by the app build | Own global dir, project dir, login, sessions, packages, banner, process title, self-update target |
| Env names | Pi's `config` and callers | `PI_*` becomes `TAU_*` so a user's Pi env never affects Tau |
| `pi.dev` services | Install telemetry, version check, installer endpoints | Removed; Tau checks npm for updates |
| Attribution and `User-Agent` | Provider attribution, catalog and installer requests | Tau's name, or none |
| Child env | `PI_CODING_AGENT`, `AI_AGENT` | `TAU_CODING_AGENT`, `AI_AGENT=tau` |
| Startup header | `components/pi-logo` and the header text in `interactive-mode` | Tau icon, wordmark, onboarding line (see Startup experience) |
| Defaults | Settings getters, or first-launch write (decision 18) | `quietStartup: "header"`, no Anthropic extra-usage warning (decision 17), `defaultTools` |
| Supplied modules | Extension loader's host-module list | Adds `@shanepadgett/tau-sdk` and its subpaths; keeps `@earendil-works/*` and `@mariozechner/*` |

Kept on `pi.dev` for now (agreed): MCP OAuth client metadata (`pi.dev/oauth`) and the share viewer (`pi.dev/session/`). There Tau still presents itself as Pi. Revisit if Tau gets its own domain. Model catalog refreshes from `pi.dev` also stay for now (agreed), so new models arrive without a Tau release.

Provider logins (Anthropic, OpenAI Codex, Copilot, Gemini) work unchanged. They use the vendors' client IDs and localhost callbacks.

`AGENTS.md`, `CLAUDE.md`, and `~/.agents/skills` stay shared across tools on purpose.

## Startup experience (agreed requirements)

Tau launches with its own header, a silent resource listing by default, and no Anthropic extra-usage warning.

### Header

Pi builds its startup header in `interactive-mode` from `components/pi-logo` (a 4×2 half-block logo with the version on the first line and key hints beside it, a text wordmark on Apple Terminal, and a 3D easter egg on logo click) plus a Pi onboarding line.

- Tau's change set replaces `pi-logo` with a Tau logo module: a large tau icon in half-block pixel art, Tau's version, and Tau's wordmark fallback for Apple Terminal. The Pi easter egg is removed.
- The icon falls back to the compact wordmark when the terminal is too short or narrow to fit it above the editor.
- The onboarding line becomes Tau's.
- Key hints keep using `keyHint`/`keyText` (already the case in Pi's header).
- Building it in Pi's header code avoids the flash that `ctx.ui.setHeader` from an extension would cause, because extensions replace the header only after Pi has drawn its own. `ctx.ui.setHeader` stays available for users who want their own header.

### Silent startup

Pi's `quietStartup` setting already supports `"header"`: keep the header, hide the model scope line and the loaded extensions, skills, prompts, and themes. Load errors still show (`showDiagnosticsWhenQuiet`). `--verbose` and the expand key still show the full listing.

- Tau's default for `quietStartup` becomes `"header"` instead of `false`.

### Anthropic extra-usage warning

Pi shows once per session: "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits." It is controlled by `warnings.anthropicExtraUsage` (default `true`) and listed under warnings in `/settings`.

- Tau does not show it. How (remove the code or default the setting to off) is decision 17.

## Separation surface

| Surface | Pi | Tau |
| --- | --- | --- |
| Executable | `pi` | `tau` |
| Global dir | `~/.pi/agent` | `~/.tau/agent` |
| Project dir | `.pi/` | `.tau/` |
| Login | `~/.pi/agent/auth.json` | `~/.tau/agent/auth.json` |
| Sessions, trust, models, keybindings, packages | under `~/.pi/agent` | under `~/.tau/agent` |
| Env | `PI_*` | `TAU_*` |
| Process title, banner | `pi` / `π` | `tau` |
| Self-update and version check | Pi package, `pi.dev` | `@shanepadgett/tau`, npm registry |

## Architecture

```text
pi/                      upstream subtree (its packages/: ai, agent, tui, coding-agent, codemode, mcp, …)
packages/
  sdk/                   @shanepadgett/tau-sdk: facade over Pi plus Tau services and components
    index.ts             extension API (re-exported from pi-coding-agent) + Tau services
    tui.ts               pi-tui + Tau components and theme (former @shanepadgett/tau-tui)
    ai.ts                pi-ai models, providers, message types
    schema.ts            typebox
  agent/                 private: Tau built-in extensions, prompts, skills, themes, docs
  app/                   @shanepadgett/tau: bin `tau`
    entry/cli.ts         production entry
    entry/dev.ts         development entry
    entry/registry.ts    InlineExtension[] for every built-in
    scripts/build.ts     bundle Pi + SDK + built-ins, copy assets, build SDK types
```

Root workspaces include `packages/*` and `pi/packages/*`. Tau's lint, format, and dead-code tools exclude `pi/`.

### Dependency direction

```text
third-party extension ─┐
Tau built-in extension ─┴─▶ @shanepadgett/tau-sdk ─▶ pi/packages/*
app entry ─▶ registry ─▶ built-ins;  app entry ─▶ pi-coding-agent main()
```

Built-in extensions import Pi only through the SDK. A lint rule enforces it. This proves the SDK is complete, keeps built-ins off Pi internals that authors cannot reach, and confines upstream renames to the facade.

### Production path

```text
tau → app dist/cli.js
  main(argv, { extensionFactories: tauExtensions })

registry.ts
  export const tauExtensions: InlineExtension[] = [
    { name: "explore", factory: explore, builtin: true },
    …
  ]
```

`builtin: true` makes each built-in disableable as `-builtin:<name>` and listed by `tau config`.

### Development path

```text
mise run dev → app dist/dev.js (same build, no factories)
  main(["-e", "packages/agent/extensions/<name>/index.ts", …, ...argv])
```

Development loads built-ins from source through Pi's jiti loader, so `/reload` keeps working. The two paths differ only in how extensions are injected. The repo's `.tau/settings.json` must not list source extensions, or an installed `tau` run in this repo would load them twice.

### Build

The app build bundles Pi's packages, the SDK, and built-ins, and copies Pi's runtime assets (themes, interactive assets, export templates) and docs. WASM and native dependencies (`@ast-grep/wasm`, `web-tree-sitter`, `@vscode/tree-sitter-wasm`, photon, quickjs) stay external runtime dependencies. The same build emits the SDK's bundled type declarations, which include Pi's types, into the app (`types/`) and into the published SDK package.

## Extension authoring

### SDK (agreed)

`@shanepadgett/tau-sdk` is the only package authors depend on. At runtime the app supplies it, so every extension shares Tau's single copy. Its version is Tau's version.

| Import | Contents |
| --- | --- |
| `@shanepadgett/tau-sdk` | Extension API and types, re-exported in full from `pi-coding-agent`, plus Tau services |
| `@shanepadgett/tau-sdk/tui` | `pi-tui` primitives, Tau components (`ToolPanel`, `Tabs`, `SelectableList`, key hints, markers), theme |
| `@shanepadgett/tau-sdk/ai` | Models, providers, message types |
| `@shanepadgett/tau-sdk/schema` | TypeBox |

Tau services in the first SDK release (agreed, all public and kept stable):

- Settings sections: `defineSettings({ key, schema, defaults })` with validation, repair, schema contribution, and `/tau doctor` coverage
- Typed events: a declared event map for `tau:*` events, augmentable by packages
- Tool groups: `registerToolGroup` and the deferred-tools prompt listing
- Bounded tool results: the shared truncation and overflow-file handler
- Quick-model and fallback helpers
- Isolated sessions
- File injection
- Image generation

Each service gets an API review before the first SDK release, because its current shape was internal.

### Packages

```json
{
  "name": "my-tau-package",
  "keywords": ["tau-package"],
  "tau": { "extensions": ["./extensions/*/index.ts"], "engine": "^2.0" },
  "peerDependencies": { "@shanepadgett/tau-sdk": "*" },
  "devDependencies": { "@shanepadgett/tau-sdk": "2.x" }
}
```

- `tau.engine` is checked at load. An incompatible package is reported and skipped.
- `tau install` rejects packages that list `@shanepadgett/tau-sdk` or `@earendil-works/*` in `dependencies`.
- Packages with a `pi` manifest keep working through the supplied `@earendil-works/*` modules. Tau packages do not run on Pi.

### Local extensions and editor types (agreed)

Local extensions in `.tau/extensions/` or `~/.tau/agent/extensions/` need no `package.json` or `node_modules`. Editor types come from the running Tau:

- The app ships SDK declarations in `<app>/types/`.
- The built-in `tau` extension refreshes them on `session_start`. If the project is trusted and `.tau/extensions/` exists, it reads `.tau/types/.version`. When that differs from Tau's version, it writes the declarations to a temporary directory and renames it to `.tau/types/`. It also writes `.tau/.gitignore` containing `types/`. The same check runs for `~/.tau/agent/extensions/` and `~/.tau/agent/types/`.
- The cost per session is one small file read. Projects without `.tau/extensions/` get nothing written.
- `/tau types` forces a refresh.
- `tau new extension` writes the types and a `tsconfig.json` that maps `@shanepadgett/tau-sdk` and its subpaths to the types folder.
- After a Tau upgrade, types refresh on the next launch in that project. Until then the editor shows the previous version's types; the extension still runs against the installed Tau.

This is product behavior in a built-in extension, not a repo-local dev extension.

### Authoring commands

`/tau-new`, currently a dev-only extension in this repo, becomes `tau new extension|package|theme|skill`. It writes the directory, `index.ts`, a README, and `tsconfig.json`, and for packages the `package.json` above.

## One settings model (agreed)

Tau has one settings concept. Pi's core settings and Tau's sections share one file per scope.

- **Files:** `~/.tau/agent/settings.json` and `<project>/.tau/settings.json`. No separate Tau settings file and no `extensions` wrapper; in Pi's settings `extensions` is the resource list.
- **Layout:** sections are top-level keys next to Pi's: Tau's (`explore`, `footer`, `modelFallback`, `reference`, `silentCommandRunner`, `toolApproval`, `worktree`) and those of third-party packages using `defineSettings`.
- **Collision guard:** the schema generator fails when a Tau section key matches a key in Pi's `Settings` type. Packages that collide with core or another package are reported at load.
- **Reads:** per-section validation and repair, with the same project-trust gating as Pi.
- **Writes:** replace only the section's own key under the same lock Pi's settings storage uses (`proper-lockfile`, `lockSync(path, { realpath: false })`). With the fork, this can be a section API on Pi's `SettingsManager` instead of a second writer. Decide when implementing; it adds to the change set.
- **Whole-extension switches:** remove `footer.enabled`, `toolApproval.enabled`, and `silentCommandRunner.enabled`. Use `"extensions": ["-builtin:<name>"]`. Finer switches stay: `explore.read.enabled` and per-command `enabled` in silent-command-runner.
- **Schema:** a published schema covers Pi's `Settings` type plus Tau's sections. Because packages add sections, Tau also writes `~/.tau/agent/settings.schema.json` covering installed packages, and `settings.json` points `$schema` there.
- **Commands:** `/tau init` is removed. `/tau doctor` validates the whole file.
- **State dirs:** no `tau/` subfolders. Global state in `~/.tau/agent/<name>`, project state in `.tau/<name>`. Names must not collide with Pi's: `sessions`, `npm`, `git`, `extensions`, `skills`, `prompts`, `themes`, `types`, `settings.json`, `auth.json`, `models.json`, `trust.json`, `keybindings.json`, `mcp.json`.
- **Tool loading (agreed):** first launch writes `"defaultTools": ["+codemode", "+tool_search"]`. Tool-loader stops activating tools and only warns when a group exists but its loader tool is inactive or disabled. The deferred-tools prompt listing stays.

## First-launch transfer from Pi (agreed)

Tau never reads Pi's state on its own. On first launch, if Pi's global dir exists, Tau offers to copy selected items. Nothing in Pi's dir is moved or changed.

### Detection

- Runs in the app entry before `main()` loads settings and auth, as a plain terminal prompt (agreed).
- Triggers when stdin and stdout are a TTY, `~/.tau/agent` has no transfer record, and Pi's dir (`PI_CODING_AGENT_DIR` or `~/.pi/agent`) exists.
- Records `transferred` or `declined` so the prompt never repeats. Print mode, RPC mode, and non-TTY runs skip it without recording.
- `tau import-pi` reruns it, including after a decline.

### Transferable items

| Item | Source | Handling |
| --- | --- | --- |
| Logins | `auth.json` | Copy. Overwrite only if Tau has none. |
| Pi settings | `settings.json` | Copy, minus the `packages` entry for `@shanepadgett/tau-agent` |
| Tau settings | `tau/settings.json` | Merge each `extensions.<key>` into top-level `<key>`. A removed `enabled: false` becomes `-builtin:<name>`. |
| Custom models | `models.json` | Copy |
| Keybindings | `keybindings.json` | Copy |
| Trusted projects | `trust.json` | Copy |
| Global MCP servers | `mcp.json` | Copy |
| User resources | `extensions/`, `skills/`, `prompts/`, `themes/` | Copy |
| Installed packages | `packages` in `settings.json` | Reinstall through Tau; do not copy `npm/` or `git/` |
| Sessions | `sessions/` | Offered, unchecked by default; copying can be large |

Caches (`models-store.json`, `mcp-tools-cache.json`, `cache-diagnostics/`) and logs are skipped.

### Flow

```text
tau (first launch)
  detect Pi dir → checklist (defaults: everything except sessions)
  copy into a temporary dir under ~/.tau/agent, then rename into place
  reinstall selected packages
  write transfer record → main()
```

A failed copy leaves no partial files and no record, so the next launch offers again. `tau import-pi --project` copies a repo's `.pi/contexts`, `.pi/extensions`, `.pi/prompts`, `.pi/skills`, `.pi/mcp.json`, `.pi/settings.json`, and `.pi/tau/` into `.tau/`.

## Tau code changes required

- **Hardcoded paths:** replace `.pi` and `~/.pi/agent` with `CONFIG_DIR_NAME` and `getAgentDir()` in `shared/settings/paths.ts`, `shared/jsonl-store.ts`, `extensions/context/definitions.ts`, `extensions/context/index.ts`, `extensions/footer/index.ts`, `extensions/ready/index.ts`, and `extensions/ready/scan.ts`.
- **Bundling breakers:**
  - `shared/settings/specs.ts` discovers settings modules by file glob and dynamic import. Replace with a static registry, which also feeds schema generation.
  - `tau-help` reads `help.md` and `docs/` relative to `import.meta.url`.
  - `src/ast/grammars/manifest.ts` resolves WASM through `import.meta.url` and `createRequire`.
  - `extensions/appshot/native-helper.ts` and `extensions/review/session.ts` use paths relative to `import.meta.url`.
- **Module state:** jiti loads each file extension with `moduleCache: false`; bundled built-ins share one module graph. Audit module-level state. Found so far: `writeQueues` in `shared/settings/json.ts`, where sharing is beneficial.
- **Imports:** built-ins move from `@earendil-works/*` and `@shanepadgett/tau-tui` imports to the SDK.
- **`/tau doctor`:** remove the Pi version check.

## Repository changes

- Add the `pi/` subtree and workspace entries. Exclude `pi/` from Tau's lint, format, and dead-code checks.
- Add `docs/standards/pi-fork.md`: the change set, the upgrade procedure, and the rule that Pi's source changes only through it.
- Add `AGENTS.md` rules for `pi/`: change only through the documented change set; Pi's tests belong to upstream and run only during upgrades.
- Add a mise task that runs upstream's test suite, used by the upgrade procedure.
- Replace `packages/tui` with `packages/sdk`. Make `packages/agent` private. Add `packages/app`.
- Move `.pi/` to `.tau/`. Update `AGENTS.md`, `docs/`, `mise.toml`, `.fallowrc.jsonc`, root `package.json` scripts, and `tsconfig.json`.
- Remove the `pi` manifests and the `pi-package` keyword. Rewrite both READMEs and drop the Pi pin-alignment rule.
- Rewrite `check-package-sources.ts` and the publish dev extension for `@shanepadgett/tau` and `@shanepadgett/tau-sdk`.

## Pi upgrades

1. `git subtree pull --prefix pi upstream <tag> --squash`.
2. Resolve conflicts against `docs/standards/pi-fork.md`.
3. Run an identity audit over `pi/` source: `pi.dev`, attribution strings, and `PI_*` env names, diffed against an allowlist. New hardcodes show up as diffs. The allowlist holds the `pi.dev` OAuth metadata and share viewer URLs.
4. Run upstream's test suite. It runs only on upgrades, not in Tau's everyday checks.
5. Regenerate the settings schema; the collision guard fails if Pi added a key a Tau section uses.
6. Rebuild the app and SDK types. Review SDK type changes as possible breaking changes for authors.
7. Release.

## Distribution phases

1. **npm global:** `npm i -g @shanepadgett/tau` (Node ≥22.19).
2. **Bun binary** with a `curl` installer and Homebrew. Pi's `build:binary` layout applies directly. Needs embedded WASM, a fix for `script-runner` (uses `process.execPath` as `node`), and per-platform signing.

## Implementation order

Each step leaves the repo green.

1. Path hygiene and a static settings registry. Still runs under Pi.
2. Add the Pi subtree at the tag matching 1.1.0. Tau's Pi dependencies resolve to the subtree. No behavior change.
3. Identity change set and `packages/app` (entries, registry, build). `tau` runs locally with its own dirs. Includes the startup changes: Tau header and icon, silent startup default, Anthropic warning.
4. SDK facade, supplied-module change, built-ins moved to the SDK, `tau-tui` folded in, types build and `.tau/types` refresh, `tau new`.
5. Move the repo from `.pi/` to `.tau/`. Apply the single settings model.
6. First-launch transfer and `tau import-pi`.
7. Publish cutover: `@shanepadgett/tau` and `@shanepadgett/tau-sdk`. Publish a final `@shanepadgett/tau-agent` release whose only behavior is a one-time notice inside Pi ("Tau is now standalone: npm i -g @shanepadgett/tau"), then `npm deprecate` it. `npm deprecate` `@shanepadgett/tau-tui` with a pointer to `@shanepadgett/tau-sdk/tui`.
8. Bun binary.

## Open decisions

1. ~~Package names~~ Agreed: `@shanepadgett/tau` (app) and `@shanepadgett/tau-sdk`. Old packages retired as in implementation step 7.
2. ~~Tau settings file location~~ Agreed: one `settings.json` per scope.
3. ~~Pi catalog service~~ Agreed: keep `pi.dev` refreshes for now.
4. ~~Third-party Pi packages~~ Agreed: `tau install npm:<pi-package>` keeps working.
5. ~~`tau-tui`~~ Agreed: folded into `@shanepadgett/tau-sdk/tui`.
6. ~~Data import~~ Agreed: first-launch transfer plus `tau import-pi`.
7. ~~Sessions in the transfer~~ Agreed: offered, unchecked by default.
8. ~~Transfer prompt UI~~ Agreed: plain terminal prompt before `main()`.
9. ~~Tool loader activation~~ Agreed: `defaultTools` written at first launch; tool-loader only warns.
10. ~~Public API~~ Agreed: the SDK, with all eight services listed under Extension authoring.
11. ~~Wrapper or fork~~ Agreed: tracking fork, Pi package names unchanged, SDK facade.
12. ~~Env names~~ Agreed: `PI_*` becomes `TAU_*` in the fork.
13. ~~Hosted services~~ Agreed: keep `pi.dev` for MCP OAuth client metadata and the share viewer for now.
14. ~~Fork location~~ Agreed: `pi/` subtree in this repo, one release for everything.
15. ~~Pi's tests~~ Agreed: run upstream's suite on each upgrade only.
16. **SDK types build:** choose the declaration bundler during step 4, after trying candidates against Pi's declarations.
17. **Anthropic warning:** remove the warning, its setting, and its `/settings` entry from Pi's source, or default `warnings.anthropicExtraUsage` to `false` and keep the opt-in.
18. **Where Tau's defaults live:** change defaults in Pi's settings getters (one documented "Tau defaults" change covering `quietStartup`, the Anthropic warning, and `defaultTools`), or write them into `settings.json` at first launch as agreed for `defaultTools` in decision 9.
19. **Tau icon:** design, size in terminal rows, and colors (fixed brand colors, as Pi does, or theme colors).
