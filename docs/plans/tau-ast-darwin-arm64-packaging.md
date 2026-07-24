# Tau AST Darwin arm64 Packaging

Status: approved

## Goal

Publish the current `tau-ast` worker inside `@shanepadgett/tau-agent` for Apple Silicon Macs. The binary must be built from the tagged source, included in the npm tarball, and executable after installation. It must never be committed to Git, and users must not need Rust or Cargo.

## Fixed scope

- Support `darwin-arm64` only in this slice.
- Bundle the binary directly in `@shanepadgett/tau-agent`; do not create a platform npm package yet.
- Build the published binary on GitHub's arm64 `macos-14` runner.
- Pass the binary between workflow jobs with a temporary GitHub Actions artifact.
- Keep `packages/agent/native-bin/` ignored and untracked.
- Build a separate temporary binary during `/publish` so the local package preflight exercises the same layout before a tag is pushed.
- Delete the local staged binary whether preflight succeeds or fails.
- Let source checkouts use the existing Cargo target as a development fallback.
- On unsupported installed platforms, fail only when an AST tool starts the worker. Other Explore tools must continue working.
- Do not download executables at install time or runtime.
- Do not commit generated binaries, checksums, or package tarballs.

## Package layout

The staged and published artifact lives at:

```text
packages/agent/native-bin/darwin-arm64/tau-ast
```

`packages/agent/package.json` includes `native-bin/**/*` in its `files` list. The Rust crate, Cargo target directory, fixtures, and build scripts remain outside the npm package.

The release build command is:

```bash
cargo build \
  --release \
  --locked \
  --target aarch64-apple-darwin \
  --manifest-path packages/agent/native/tau-ast/Cargo.toml
```

The source artifact is:

```text
packages/agent/native/tau-ast/target/aarch64-apple-darwin/release/tau-ast
```

## Implementation

### 1. Shared staging and smoke script

Add a repository script under `packages/agent/scripts/` with explicit `stage`, `smoke`, `verify-pack`, and `clean` actions.

`stage` must:

- reject hosts other than `darwin-arm64`;
- require the release artifact produced by the locked Cargo command;
- create the package artifact directory;
- copy the release binary to the package path; and
- apply executable permissions.

`smoke` must start the staged executable through the real framed protocol, complete a handshake, outline a checked-in TypeScript fixture, and shut the worker down. Reuse `AstWorkerClient` rather than duplicating protocol framing.

`verify-pack` must run or inspect `npm pack --dry-run --json` output and fail unless the package file list contains exactly the expected native artifact path with a nonzero size.

`clean` must remove the staged package artifact and its empty parent directories without touching Cargo build output.

The script must use paths derived from the repository root and produce direct errors for a missing build, wrong host, failed smoke request, or missing packed artifact.

### 2. Runtime worker resolution

Update `packages/agent/extensions/explore/ast-worker.ts` so its default command resolution follows this order:

1. Use the packaged `native-bin/darwin-arm64/tau-ast` on Apple Silicon Macs when it exists.
2. In a source checkout containing the Rust manifest, fall back to the local Cargo release binary so development remains unchanged.
3. Otherwise retain an explicit startup error explaining that packaged AST tools currently require an Apple Silicon Mac.

Do not throw while the Explore extension is registering. Defer the platform or missing-artifact error until `outline` or `symbol` starts the worker. Explicit command injection used by worker tests remains supported.

### 3. npm package metadata

Update:

- `.gitignore` to ignore `packages/agent/native-bin/`;
- `packages/agent/package.json` to include `native-bin/**/*`; and
- the Explore README and Tau help text to state the current packaged-platform boundary and that users do not need Cargo.

Package documentation should describe user-visible support only. Build mechanics stay in this plan and release code.

### 4. Local `/publish` preflight

Update the publish extension before its existing npm pack checks:

1. Reject release publishing unless the host is `darwin-arm64`.
2. Build the locked `aarch64-apple-darwin` release worker with enough timeout for a cold Cargo build.
3. Stage the binary into the package layout.
4. Smoke-test the staged worker.
5. Run the existing package dry runs.
6. Verify that the agent package file list contains the staged worker.
7. Clean the staged artifact in `finally` before release files are committed and the tag is created.

Update the publish activity panel so the native build, smoke test, and package verification are visible steps.

The release commit must continue staging only source manifests and the lockfile. Add an explicit guard that fails if any path under `packages/agent/native-bin/` is tracked or staged.

### 5. GitHub release workflow

Split `.github/workflows/publish.yml` into a native build job and the existing publish job.

The native job must:

- run on `macos-14`, which GitHub documents as an arm64 hosted runner for public repositories;
- check out the tagged source;
- install the pinned Rust 1.88.0 toolchain;
- install npm dependencies needed by the shared smoke script;
- run the same locked Cargo build, stage, and smoke operations used locally;
- upload only `native-bin/darwin-arm64/tau-ast` as `tau-ast-darwin-arm64`; and
- never modify or commit repository state.

The Ubuntu publish job must:

- depend on the native build job;
- download the artifact into the package layout;
- restore executable permissions because workflow artifact transfer does not preserve them reliably;
- run package-source checks and dependency installation;
- run both package dry runs;
- verify the packed agent file list contains the binary; and
- publish the existing workspaces through npm trusted publishing.

The workflow artifact is temporary transport. It is not a GitHub Release asset and is not retained as repository history.

### 6. Tests

Add or update tests for:

- explicit worker command injection remaining unchanged;
- packaged-path selection on `darwin-arm64`;
- source-checkout fallback when no packaged artifact exists;
- deferred unsupported-platform errors;
- deferred missing-artifact errors;
- the rest of Explore registering when the worker cannot start;
- staging and cleanup leaving no tracked or untracked package artifact;
- package verification rejecting a tarball without the binary; and
- the staged release worker completing one real outline request.

Keep normal unit tests independent from a prebuilt binary. Real binary and package-boundary smoke checks belong in the staging script and macOS workflow.

## Validation

Before considering the implementation complete:

1. Run the focused Explore worker and publish-extension unit tests.
2. Build the locked arm64 release worker locally.
3. Stage and smoke-test it.
4. Run the agent package dry run and confirm `native-bin/darwin-arm64/tau-ast` appears once.
5. Inspect the packed file mode and size.
6. Clean staging and confirm `git status` contains no generated binary.
7. Run repository checks normally.
8. Review the final workflow for artifact path, job dependency, permissions restoration, and trusted npm publishing order.

Do not create a tag, push, publish, or open a pull request during validation.

## Acceptance criteria

- A tagged release builds `tau-ast` from the same tagged source on GitHub's Apple Silicon runner.
- The exact npm package published by the Ubuntu job contains an executable `native-bin/darwin-arm64/tau-ast`.
- A fresh Apple Silicon installation can run `outline` and `symbol` without Rust, Cargo, postinstall scripts, or runtime downloads.
- Linux, Windows, and Intel Mac installations can still load Tau and use non-AST Explore tools; invoking an AST tool reports the platform limitation clearly.
- `/publish` catches native build, smoke, and package-layout failures before pushing a tag.
- No native binary or npm tarball is tracked, staged, or committed.
