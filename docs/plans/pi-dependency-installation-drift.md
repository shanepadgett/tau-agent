# Pi dependency installation drift

Status: proposed

## Goal

Make Tau fail clearly when installed Pi packages do not match the versions declared by the repository, then restore the current development environment to the locked Pi 0.81.1 baseline.

Do not rewrite footer accounting, subagent provider handling, run summaries, or model fallback code unless those files still fail after a clean install.

## Finding

The TypeScript failures reported after the Context Pruning fix come from stale local dependencies:

| Package | Declared and locked | Installed locally |
| --- | --- | --- |
| `@earendil-works/pi-ai` | `0.81.1` | `0.80.9` |
| `@earendil-works/pi-coding-agent` | `0.81.1` | `0.80.9` |
| `@earendil-works/pi-tui` | `0.81.1` | `0.80.9` |

Tau's source intentionally uses APIs added during the completed Pi 0.81 alignment:

- `ToolResultMessage.usage`;
- usage on compaction and branch-summary entries;
- `ModelRegistry.getProvider()`;
- `ModelRuntime.registerNativeProvider()`.

Pi 0.81.1 documentation and release notes still describe those APIs. The installed 0.80.9 declarations do not contain them, which accounts for every reported TypeScript error. The errors do not currently justify a source migration.

## Decisions

### Treat the lockfile as authoritative

Keep the three direct Pi packages pinned together at exact version `0.81.1`. Keep workspace peer dependency declarations unchanged.

Repair local dependencies with the repository's pinned npm version and a clean lockfile install. Use `--ignore-scripts`, matching the repository's dependency-safety practice and publish workflow.

### Detect drift before TypeScript

Add a small, network-free Mise check that verifies the installed top-level dependency tree satisfies `package.json`. Prefer npm's own tree validation over a Tau-owned package-version parser. The lockfile remains authoritative for the clean reinstall.

The failure must say to run:

```bash
npm ci --ignore-scripts
```

Run this check before tasks that execute local binaries or load installed type declarations. A stale install should not surface later as unrelated TypeScript API errors.

### Keep the source migration conditional

After installing 0.81.1, run the normal repository checks. If the existing source compiles, make no changes to footer, run-summary, subagent, or model-fallback code.

If errors remain, capture the exact installed 0.81.1 declarations and compare them with Pi's packaged 0.81.1 documentation and changelog before changing Tau. Do not add casts, compatibility branches, or private-runtime access to silence a broken package installation or upstream packaging defect.

## Implementation slices

### Slice 1: Restore the locked install

- Confirm the active Node and npm versions match `mise.toml` and `package.json`.
- Run `npm ci --ignore-scripts` from the repository root.
- Confirm the three installed direct Pi packages resolve to `0.81.1`.
- Confirm `package.json` and `package-lock.json` remain unchanged.
- Run the existing repository checks.

Expected tracked files: none.

If all checks pass, do not start the conditional source migration. Continue only with the early drift check and contributor documentation.

### Slice 2: Add an early dependency check

- Add `check:dependencies` to `mise.toml` using npm's installed-tree validation.
- Give failures one direct recovery command: `npm ci --ignore-scripts`.
- Make `check:ts` run the dependency check before schema, formatting, type, unit, and dead-code work.
- Keep the check network-free and read-only.
- Verify it fails against an intentionally stale or missing top-level Pi package and passes after the clean install.

Files:

- `mise.toml`

### Slice 3: Make contributor setup deterministic

- Replace `npm install --ignore-scripts` with `npm ci --ignore-scripts` in contributor setup.
- State that contributors should rerun the command after pulling dependency or lockfile changes.
- Keep publishing instructions unchanged; the publish workflow already uses `npm ci --ignore-scripts`.

Files:

- `docs/CONTRIBUTING.md`

### Conditional slice: Investigate a real 0.81.1 package mismatch

Perform this slice only if a clean install still reports missing usage or provider APIs.

- Record the installed versions and relevant public declarations.
- Compare them with Pi 0.81.1's changelog, extension docs, session-format docs, and SDK docs.
- Check whether a newer fixed Pi patch exists.
- Prefer moving all three direct Pi packages together to a fixed patch release.
- If no fixed release exists, pin all three back to the last verified compatible release rather than weakening Tau's types or behavior.
- Update the lockfile and rerun the existing provider, subagent, footer, run-summary, package, and full repository tests.

Possible files only if this conditional slice is required:

- `package.json`
- `package-lock.json`

## Acceptance criteria

- Installed direct Pi packages match the exact declared and locked versions.
- The current Context Pruning changes and the existing Pi 0.81-aligned source pass repository checks without unrelated casts or compatibility code.
- A stale or missing dependency installation fails before TypeScript with a direct repair command.
- Contributor setup uses the lockfile-reproducible install command.
- No runtime behavior changes in footer accounting, run summaries, subagent provider dispatch, or model fallback unless a verified Pi package defect requires a separate approved migration.

## Out of scope

- Changing Context Pruning behavior beyond the current aborted-tool-call fix.
- Supporting Pi 0.80 and 0.81 simultaneously.
- Replacing npm or Mise.
- Adding an automatic dependency install to checks.
- Updating Tau package versions or publishing a release.
- Reworking provider, usage-accounting, or subagent architecture without a failure reproduced on the locked dependency baseline.

## References

- `package.json`
- `package-lock.json`
- `mise.toml`
- `docs/CONTRIBUTING.md`
- Pi 0.81.1 `CHANGELOG.md`
- Pi `docs/extensions.md`
- Pi `docs/session-format.md`
- Pi `docs/sdk.md`
