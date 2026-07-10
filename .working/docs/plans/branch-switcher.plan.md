# Branch switcher plan

## Goal

Make `/branch` an immediate, ten-row recent-first branch picker with an explicit `Ctrl+F` refresh, while keeping branch creation under `/branch new`.

## Scope

- `/branch` opens from local and already-fetched remote-tracking refs without network work.
- The picker uses Tau's shared `SelectableList` inside `ToolPanel`, capped at 10 visible branches.
- Local and remote-only branches are ordered by latest commit date. The current local branch and remote counterparts of existing local branches are omitted.
- `Ctrl+F` runs `git fetch --all`, shows an in-panel fetching state, then refreshes and re-sorts the open list.
- Fetch failure keeps the existing choices and reports the error.
- Selecting a local branch runs `git switch <name>`.
- Selecting `<remote>/<name>` runs `git switch --track -c <name> <remote>/<name>`.
- `/branch new` preserves the existing type, name normalization, creation, cancellation, and error flow.
- Other arguments report usage and do no Git work.

## References

Read only these ranges unless implementation evidence makes them insufficient:

- `src/extensions/branch/index.ts:1-143` — current routing, ref parsing, automatic fetch, switching, and creation.
- `test/extensions/branch/index.test.ts:1-202` — current command harness and automatic-fetch expectations to replace.
- `src/extensions/branch/README.md:1-19` — current documented automatic-fetch behavior.
- `src/shared/git.ts:1-24` — Git runner contract and timeout behavior.
- `docs/tui.md:1-105` — Tau TUI reach order, composition, key-hint, and network/UI separation rules.
- `src/shared/tui/selectable-list.ts:49-100,102-184,186-258,378-420` — list item/config API, `maxVisible`, custom actions, key handling, item refresh, and hints.
- `src/shared/tui/tool-panel.ts:5-51,53-89` — panel config, mutable config rendering, and footer states.
- `src/shared/tui/key-hints.ts:4-24` — remap-aware and raw key hints.
- `src/extensions/reference/panel.ts:448-488,564-575` — immediate cached picker, guarded async refresh, `setItems`, and rerender precedent.

## Files

- Update `src/extensions/branch/index.ts`.
- Add `src/extensions/branch/panel.ts` for the focused picker UI.
- Update `test/extensions/branch/index.test.ts`.
- Add `test/extensions/branch/panel.test.ts` only if interaction coverage cannot stay clear in the existing command test.
- Update `src/extensions/branch/README.md`.

## Steps

1. Keep argument routing and `/branch new` behavior unchanged.
2. In the switch path, discover the repository and immediately read local plus cached remote-tracking refs with the existing single `git for-each-ref` call. Remove the launch-time `git fetch --all`.
3. Keep ref parsing in the command module. Preserve recent-first ordering, deterministic ties, current-branch exclusion, symbolic `HEAD` exclusion, and local-over-remote deduplication.
4. Move picker rendering and interaction into `src/extensions/branch/panel.ts`. Compose `SelectableList` and `ToolPanel`; do not create another list implementation or alter shared TUI.
5. Configure single selection, `maxVisible: 10`, remap-aware select/navigation/cancel behavior from `SelectableList`, and one fixed `Ctrl+F` action using `Key.ctrl("f")` plus `rawHint("ctrl+f", "fetch")`.
6. Keep Git outside the panel. Pass an async refresh callback from the command that runs `git fetch --all` with the existing network timeout, rereads refs, and returns freshly parsed choices.
7. When refresh starts, show `Fetching branches…` in the panel, ignore repeated fetch/select actions, and rerender immediately. Keep cancel available. On success, call `setItems` with the refreshed choices while preserving the active item by id. On failure, retain old choices, restore normal hints, and notify the error.
8. Guard refresh completion against a picker that was cancelled or closed while fetching, following the reference picker identity/liveness pattern.
9. Return the selected branch choice to the command. Keep local and tracked-remote switch commands and success/error notifications there.
10. Open the panel even when the initial list is empty so `Ctrl+F` can discover branches. Render a useful empty-state message instead of closing early.
11. Replace tests that expect automatic fetch and native `ctx.ui.select`. Cover immediate opening without fetch, ten-row windowing, `Ctrl+F` fetch and in-place refresh, duplicate fetch suppression, fetch failure retention, cancellation during fetch, recent-first choices, and local/remote switching. Keep `/branch new` and invalid-argument coverage.
12. Update the README to describe cached startup, the ten-row picker, `Ctrl+F` refresh, and `/branch new`.

## Edge cases

- Outside a Git repository: report the existing error and do not open the panel.
- No cached switchable branches: open the empty panel; `Ctrl+F` remains available.
- No remotes: refresh may succeed without adding branches; local choices remain.
- Detached `HEAD`: no local branch is excluded as current.
- Same short branch name on multiple remotes: show each remote-qualified choice; the selected remote becomes the upstream.
- Fetch fails: keep the panel and existing list usable.
- Picker closes during fetch: do not mutate or rerender the closed component.

## Done

- `/branch` opens without fetching and never renders more than 10 branch rows.
- `Ctrl+F` visibly fetches all remotes and refreshes the open recent-first list.
- `/branch new` behaves like the current creation flow.
- Local switching, remote tracking, refresh, failure, and cancellation paths are covered by tests.
- README matches command behavior.
