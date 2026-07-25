---
description: Update pinned deps after release-note review with user
argument-hint: "[package-name...]"
---

Update dependencies: ${ARGUMENTS:-all exact-pinned packages}

Updates deps. Never blind bumps. Every change discussed with user. Analyze first. Apply only approved work.

## Scope

- Exact pins in every workspace `package.json` (`"1.2.3"`; not ranges, `*`, or `workspace:`).
- Include `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` when exact-pinned.
- Skip this monorepo's own packages (`@shanepadgett/*` and other workspace packages that are the repo).
- Args present → those pins only. Else full inventory.
- Ignore transitive-only unless a direct pin forces it.

## Workflow

1. Inventory: package, manifest path, current version, kind.
2. Resolve latest versions in one shell call: `npm view <pkg> version` for every pin, joined (e.g. `npm view a version; npm view b version`). Repo registry.
3. Outdated pin → release notes for full current → candidate span, not latest blurb only.
4. Classify before proposing:
   - **Pure bump**: no break, no API worth adopting, no behavior shift that matters here.
   - **Material**: break, migration, deprecation hitting this repo, or new capability worth considering.
5. Present findings. No manifest/lockfile/code edits yet.
6. Decide with user per package or explicit user-chosen batches. Nothing without approval.
7. Apply only approved bumps and approved follow-on code. Leave unapproved pins.
8. Refresh lockfiles. Run normal validation for touched surface.

## Release notes

Known defaults:

- `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, other `@earendil-works/pi-*`: `https://pi.dev/news/releases/<version>` (real version; read each release in span).
- Others: stable source — upstream changelog, GitHub/GitLab releases, official notes. Prefer project changelog over mirrors.
- No reliable notes → say so. Do not invent from version numbers.

Pi pre-1.0: minor/patch can break. Pre-1.0 and fast-moving tools get high scrutiny even on small bumps.

## Discussion shape

Talk with user throughout.

- **Pure update**: say pure; list pins + deltas; notes show nothing material here; ask to bump.
- **Material update**: what changed; what breaks/might break here; what new capability worth adopting. Split:
  - must-handle breakages / migrations
  - optional adoptions that improve Tau
  - ignorable noise
- Thin evidence → say thin. No "looks fine" cover.
- No plans, refactors, or feature work unless user chooses from findings.
- Chosen adoption/migration stays scoped to the dep change that justified it.

## Constraints

- No silent upgrades.
- No lockfile churn for deferred packages.
- No drive-by refactors outside approved dep work.
- Smallest safe change for approved update.
- Coupled pins (e.g. Pi set) → call out version coupling.
- Optional args select packages only. Never skip review/approval.
