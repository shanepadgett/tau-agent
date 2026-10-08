# Worktree resilience

## Approved scope

- Allow concurrent Tau sessions in one checkout; warn rather than block tools.
- Keep removal blocked while Tau sessions use the target checkout.
- Isolate per-worktree discovery errors and show them in the picker/details.
- Offer confirmed cleanup of a selected missing registration. Preserve branches and chats.
- Leave the silent command runner unchanged.

## Architecture and call paths

- `ownership.ts`: replace exclusive editing ownership with per-session presence records. Serialize registration, release, and exclusive removal using the existing short-lived claim. Removal checks every live presence; ordinary sessions coexist.
- `index.ts`: session startup registers presence and warns when another session exists. Shutdown releases its own record. No `tool_call` blocking. Opening an occupied workspace prepares a fresh conversation instead of sharing a JSONL session file.
- `workspaces.ts`: discovery returns a required `errors: string[]` per workspace; failed metadata, status, or presence inspection stays on that row. Opening validates the selected Git identity. Removal fails closed on discovery errors.
- `/worktree` -> missing row -> cleanup confirmation -> removal claim -> fresh discovery and missing-path check -> `git worktree remove <path>` -> remove that row's Tau metadata. Git supports this operation for missing folders without `--force` or repository-wide pruning.
- Existing removal confirmation and Git-lock, dirty-file, identity, branch, and evidence checks remain.
- Picker, README, and Tau help document warnings and cleanup.

## Cache and checks

No model request fields, prompts, or historical messages change. Presence notices use UI notifications only; stable request prefixes remain unchanged.

Do not add or change tests. Check Git behavior with disposable repositories and inspect the final diff. Interactive verification requires `/reload`.

Verified with disposable resources: concurrent registration (including simultaneous claims), removal exclusion until all sessions release, removal/registration exclusion, isolated corrupt metadata and Git status errors, Git-locked cleanup refusal, cleanup of only the selected missing registration, retained branches and saved chats, and removal of its Tau metadata.
