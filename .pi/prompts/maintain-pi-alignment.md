---
description: Safely update tau-agent dependencies and keep local config aligned with the pi reference repo
argument-hint: "[instructions]"
---
Maintain this tau-agent package against the checked-in pi reference repo. Extra instructions: ${ARGUMENTS:-none}

Goals:

- Keep `package.json` dependency/tool versions current when safe.
- Keep local runtime/tooling config aligned with `references/pi` where this package intentionally mirrors pi.
- Preserve this package's narrower scope: local pi extensions, skills, prompts, and themes.

Reference sources:

- `references/pi/package.json` for monorepo-level dev tools, `engines.node`, `overrides`, and scripts worth mirroring.
- `references/pi/packages/coding-agent/package.json` for `@earendil-works/pi-coding-agent`, its pi package dependency versions, `typebox`, and package runtime expectations.
- `references/pi/packages/ai/package.json`, `references/pi/packages/tui/package.json`, and `references/pi/packages/agent/package.json` when a pi package used here depends on shared runtime packages.
- `references/pi/.npmrc`, `references/pi/biome.json`, `references/pi/tsconfig.base.json`, and `references/pi/tsconfig.json` for local config patterns. Mirror only settings that apply to this smaller package.

Process:

1. Inspect current state:
   - `git status --short`
   - `git -C references/pi status --short`
   - read this package's `package.json`, `mise.toml`, `.npmrc`, `biome.json`, and `tsconfig.json`
   - read the reference files listed above
2. If `references/pi` is behind its configured branch and updating it is safe, update with a fast-forward only:
   - `git -C references/pi fetch --prune`
   - `git -C references/pi pull --ff-only`
   Do not force, merge, rebase, or change submodule branches unless explicitly requested.
3. Version alignment rules:
   - Keep `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` `devDependencies` pinned exactly to the matching published reference package versions.
   - Keep their `peerDependencies` as `"*"` unless there is a clear package-compatibility reason to narrow them.
   - Keep `typebox` pinned exactly to the version used by pi packages.
   - Keep `@biomejs/biome`, `@typescript/native-preview`, `typescript`, and root `@types/node` aligned with `references/pi/package.json` unless this package has a deliberate local constraint.
   - Keep `engines.node` equal to the reference engine range, and keep `mise.toml` node equal to the minimum concrete Node version implied by that range.
   - Keep `.npmrc` aligned, especially `save-exact=true` and `min-release-age`.
   - Do not introduce broad ranges for dev dependencies. Prefer exact versions.
4. Safe update policy:
   - Safe: exact version bumps that match `references/pi`, config mirrors with equivalent meaning, lockfile refreshes caused only by those changes, docs updates describing the policy.
   - Not safe without asking: major dependency jumps not present in `references/pi`, changing package manager, relaxing TypeScript strictness, removing checks, changing published package shape, changing peer dependency strategy, or deleting intentional local behavior.
5. After edits:
   - Run `npm install --ignore-scripts` if dependency versions changed or `package-lock.json` needs refresh.
   - Run `npm run check` and fix all errors, warnings, and infos.
6. Report concisely:
   - files changed
   - versions/configs aligned
   - checks run and result
   - any skipped update and why
