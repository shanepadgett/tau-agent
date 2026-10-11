# Worktree session cleanup

## Agreed scope

Fix persistent false checkout warnings, release the previous registration before another `session_start`, and remove the two confirmed stale local session records. No new commands or settings.

## Architecture

Keep ownership changes under the existing exclusive claim. Session registrations are advisory presence records; removal leases and claims remain conservative exclusive locks. Expire only foreign-host session records after 24 hours, using file modification time. Never expire a live same-host PID by age. Foreign-host live sessions can be missed after 24 hours without a heartbeat; this is the accepted limitation of this cleanup policy.

## Code boundaries and call paths

- `ownership.ts`: share session inspection between `workspaceOwner` and registration cleanup. Inspection returns `{ path, owner, alive }[]`, ignores unfinished write files, checks same-host PIDs, and applies the 24-hour limit only to foreign-host sessions.
- `registerWorkspaceSession`: acquire claim, refuse an active removal lease, reap inactive session records and old workspace-specific claim/session temporary files, inspect remaining owners, then write the new registration.
- `index.ts`: release the previous registration inside the startup error boundary before Git discovery; assign the replacement only after registration succeeds. Shutdown remains idempotent.
- UI warnings remain display-only. No model request fields or prompt-cache prefixes change.

## Verification

Inspect existing types and Pi lifecycle docs. Exercise the ownership module directly with disposable temporary storage; do not add or modify repository tests. Run repository checks. Live extension validation requires the user to run `/reload`.
