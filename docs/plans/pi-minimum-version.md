# Pi minimum version

## Scope

Change the published Pi contract from exact 1.1.0 pins to `>=1.1.0`. Keep root development dependencies exactly pinned and synchronized at 1.1.0. This does not claim support below the APIs Tau already uses.

## Boundaries

- Both published manifests declare the same Pi minimum. The agent manifest is the source for startup diagnostics and package-source validation.
- Startup and `/tau doctor`: Pi `VERSION` → semver `satisfies(version, peerRange)` → an actionable finding only outside the supported range. Use semver's minimum version for the install command. Add semver as an agent runtime dependency and its types as a development dependency rather than implementing version parsing.
- Packaging: validate exact synchronized development pins, uniform `>=x.y.z` stable peer minimums, and that development pins satisfy the supported range. Preserve source and bundled-Pi checks.
- Root development rules and dependency prompts: newer development pins do not raise the minimum. Use capability detection and safe fallbacks within the supported range; require explicit approval and API evidence before raising the minimum. Newer missing named exports must not break module loading on the minimum version.
- Update installation docs and regenerate the lockfile. No new tests or compatibility branches for APIs that do not need them.

## Verification

Run the package-source check for its changed packaging contract. Finish all edits and inspection before calling `run_checks`, then summarize without another write-capable call. Runtime extension diagnostics require another user `/reload`; this change does not modify model request construction.

## Implementation status

Implemented aligned `>=1.1.0` peers, range-based runtime diagnostics, independent development-pin validation, compatibility rules, dependency-prompt guidance, and installation docs. Refreshed dependencies with scripts disabled. The package-source check and `git diff --check` passed. npm reports 11 vulnerabilities (7 high, 1 moderate, 3 low) in the existing markdownlint-cli2 dependency chain; this change does not upgrade that chain.
