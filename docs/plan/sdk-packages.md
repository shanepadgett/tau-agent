# SDK packages: how extensions are packaged, loaded and versioned

Status: round 3 of the [SDK](sdk.md) agreed. Built at steps 7 and 8 of [architecture.md](architecture.md#build-order).

Goal: the most extensible agent whose extensions are checked like ordinary code. `tsc`, lint and tests catch mistakes before Tau runs, which makes extensions easy for agents to write.

Already agreed:

- An extension gets a scoped context with only the areas it asks for ([sdk.md](sdk.md)).
- Local extensions reload on save, and a failed reload keeps the last working version.
- Spike 1 (`spikes/extension-loading/`) showed that the compiled `tau` binary serves its own copy of `@shanepadgett/tau` to extensions and reloads them by clearing Bun's module cache.

## Systems studied

| | Pi | OpenCode V2 | VS Code | Claude Code |
| --- | --- | --- | --- | --- |
| Package | npm, git or folder | npm or git package, or folder | `.vsix` | Plugin folder in a marketplace git repo |
| Entry | Conventional folders `extensions/`, `skills/`, `prompts/`, `themes/`, or paths under a `pi` key | `package.json` `exports`: `.` (plugin), `./tui` (terminal UI), `./rpc` (typed contract others import without loading the code). Default export `Plugin.define({ id, setup })` | `contributes` lists every command, menu and setting | `.claude-plugin/plugin.json`: commands, agents, skills, hooks, MCP |
| Local discovery | `~/.pi/agent/extensions/`, `.pi/extensions/` | `.opencode/plugins/` and the global config folder: files or package folders, loaded automatically | none | none |
| Selection | Settings filters per resource | Ordered `plugins` list; `-id` disables, wildcards allowed; object form passes `options` | Enable per extension | Enable per plugin |
| Skills, themes | Files in the package | Added in code through transforms (`ctx.skill.transform`), or found in `.opencode/skills/` | n/a | Files in the plugin |
| Plugin options | none | `ctx.options`, untyped | Typed settings schema | none |
| Startup | All at launch | Cached packages load at once; missing ones install in the background | Lazy, on activation events | At launch |
| Reload | `/reload` | Automatic for watched folders | Window reload | Restart |
| Version contract | Host modules as `peerDependencies: "*"` | Depend on a compatible `@opencode/plugin`; no range check | `engines.vscode`, refused outside it | Plugin version only |
| Tooling | `pi install`, `list`, `remove`, `update` | `opencode plugin add`, `list`, `check`, `update`, `remove` | `yo code` generator, `vsce`, test runner | none |

Paradigms:

- **Static manifests (VS Code).** Contributions are known before code runs, but every one is written twice.
- **Code-defined registration with scopes (OpenCode, Pi).** One source of truth, known only once the code is imported.
- **Typed contract exports (OpenCode `./rpc`).** Other packages get types and service tags without loading the implementation.
- **Engine ranges (VS Code, npm `engines`).** A version mismatch becomes a clear refusal.

## Agreed: package shape, a blend

```text
my-package/
  package.json   name, version, engines.tau, dependencies, peers
                 exports "."    -> src/index.ts   default-exports definePackage({ ... })
                 exports "./api" -> src/api.ts    optional: typed extension points for other packages
  src/index.ts   imports its extensions and themes; points to skill and prompt folders
  skills/<name>/SKILL.md, prompts/*.md
```

| Piece | Taken from | Why |
| --- | --- | --- |
| Entry through standard `exports`, default export typed | OpenCode | Normal module resolution, so `tsc`, lint and Fallow follow every import |
| `./api` export of typed extension points | OpenCode `./rpc` | `requires: [todoList]` in another package type-checks against it without loading the implementation |
| One typed `definePackage` value listing everything | New | One file shows an agent the whole package. A missing extension or bad theme is a type error |
| Skills and prompts stay files | Pi, Agent Skills | Plain Markdown; `tau check` validates their frontmatter |
| UI in the same extension, no `./tui` split | Departure from OpenCode | OpenCode splits UI because its UI may run in another process; Tau is one process |
| Local folders discovered and hot-reloaded: `~/.tau/extensions/`, `.tau/extensions/` | OpenCode, Pi | No install step for your own extensions |
| Ordered `extensions` list in settings with `-id` to disable | OpenCode | One mechanism for enabling and disabling |
| Per-package options typed by the extension's settings Schema | Improves on OpenCode | Tau generates JSON Schema for `settings.json`, so editors flag a misspelled option |

Rejected: Pi's folder scan alone, because nothing is type-checked until it runs. VS Code's static manifest, because it repeats the code.

## Agreed

| Decision | Detail |
| --- | --- |
| Areas | Declared in code: `defineExtension({ areas, requires })`. The context's type has only those areas and the extension points it requires, and Tau enforces the same list at runtime. Static lists may return in round 4 (isolation and trust). |
| Startup | Functions, commands and instruction sources are plain typed values on the definition; `activate` does only dynamic setup. All extensions start at launch, in parallel and in the background. The first model call waits for them up to a timeout; a late extension's functions arrive as a catalog update. |
| Install | `tau install npm:pkg@1.2.0`, `git:host/repo@ref` or `./path`. Personal packages go in `~/.tau/settings.json` and project packages in `.tau/settings.json`. Tau installs dependencies by running itself as the `bun` CLI (`BUN_BE_BUN=1`). `@shanepadgett/tau`, `effect`, `@opentui/*` and `solid-js` are peer dependencies that Tau always provides. |
| Versioning | The SDK follows semver with Tau's releases; its types are published to npm at the same version. Packages declare `engines.tau`; extensions outside the range are refused with a reason, while their skills, prompts and themes still load. A removed API stays one major version marked `@deprecated`. A major upgrade of Effect, OpenTUI or Solid is an SDK major version. Packages stay pinned; `tau update` moves to the newest compatible version and keeps the old install if the new one fails to load. |
| Authoring kit | `@shanepadgett/tau` on npm: types, a lint preset and Effect diagnostics. `tau check`: type-checks a package, rejects bundled host modules and out-of-range versions, and test-loads it. `@shanepadgett/tau/testing`: runs an extension in-process against a temporary session and a scripted fake model, the harness Tau's own tests use. |

## Agreed: scaffolding

`tau new package <name>`, `tau new extension <name> --global|--project`:

- **A package** gets `package.json` (`engines.tau`, peers, `exports`), a `tsconfig.json` and lint config extending the SDK presets, one sample extension with a test using the harness, and an `AGENTS.md` that says to run `tau check`.
- **A loose extension** gets one file in `~/.tau/extensions/` or `.tau/extensions/`.
- **Types for loose files.** Tau writes the embedded SDK's type declarations and a `tsconfig.json` under `~/.tau/types/`, and refreshes them when Tau's version changes. Editors and `tsc` then check loose files with no `npm install`.

## Spike before build step 8

Spike 10 (`spikes/package-install/`): from the compiled binary, with no Bun on PATH, can `BUN_BE_BUN=1` install an npm package with its own dependency? And can the extension import that dependency together with the host's SDK and Effect?
