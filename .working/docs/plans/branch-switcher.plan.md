# Branch switcher plan

## Goal

Change `/branch` into a recent-first branch switcher while keeping branch creation under `/branch new`.

## Scope

- `/branch` finds the repository, runs `git fetch --all`, then opens Pi's built-in `ctx.ui.select`.
- The picker includes local branches and fetched remote-only branches from every configured remote, ordered by latest commit date.
- The current local branch and remote counterparts of existing local branches are omitted.
- Selecting a local branch runs `git switch <name>`.
- Selecting `<remote>/<name>` runs `git switch --track -c <name> <remote>/<name>`.
- `/branch new` preserves the existing type, name normalization, creation, cancellation, and error flow.
- Other arguments report usage and do no Git work.

## References

Read only these ranges unless implementation evidence makes them insufficient:

- `src/extensions/branch/index.ts:1-53` — current command and creation flow.
- `test/extensions/branch/index.test.ts:1-24` — existing normalization coverage.
- `src/extensions/branch/README.md:1-13` — current user-facing behavior.
- `src/shared/git.ts:1-24` — existing Git runner contract and timeout behavior.
- `src/extensions/reference/panel.ts:735-839` — recent-first `for-each-ref` parsing and local-versus-remote switching precedent. Do not reuse these private, `origin`-specific helpers.

## Files

- Update `src/extensions/branch/index.ts`.
- Update `test/extensions/branch/index.test.ts`.
- Update `src/extensions/branch/README.md`.

## Steps

1. Route trimmed command arguments: empty to switching, exact `new` to the current creation flow, everything else to a usage error.
2. For switching, discover the repository, then fetch all configured remotes before reading branch refs; abort and notify if fetching fails. Keep creation's existing prompt-before-repository-check order.
3. Read local and remote-tracking refs with one `git for-each-ref` call using `--sort=-committerdate` and a machine-readable format containing full ref name and commit timestamp.
4. Parse refs into branch choices. Build the local-name set before filtering remote refs so remote counterparts are removed regardless of sort position. Exclude the current local branch and remote symbolic `HEAD` refs. Preserve descending commit-date order with branch name as deterministic tie-breaker.
5. Show choice labels as local names or remote-qualified names. Map the selected label back to either plain `git switch` or tracked local-branch creation.
6. Keep parsing and choice construction private to the branch extension. The similar reference-extension code has different ownership and only handles `origin`; sharing it would widen the change and add conditionals.
7. Extend tests through the registered command handler with small local fakes for `pi.exec` and `ctx.ui`. Cover fetch-before-list ordering, recent-first choices, current/duplicate/`HEAD` filtering, local switching, remote tracking, cancellation, fetch failure, `/branch new`, and invalid arguments.
8. Update the README and command description with `/branch` switching, fetch behavior, recency ordering, and `/branch new` creation.

## Edge cases

- Outside a Git repository: retain the existing error and perform no fetch.
- No remotes: `git fetch --all` may succeed; local branches still appear.
- No switchable branches: notify and stop without opening an empty picker.
- Detached `HEAD`: no local branch is excluded as current.
- Same short branch name on multiple remotes: show each remote-qualified choice; the selected remote becomes the upstream.
- A fetch, ref lookup, or switch failure is reported without continuing to later steps.

## Done

- `/branch` fetches all remotes and switches through Pi's built-in select menu in recent-first order.
- `/branch new` behaves like the current `/branch` creation flow.
- Local and remote-only switching paths are covered by tests.
- README matches the command behavior.
