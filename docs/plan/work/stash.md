# Stash and pop

Status: decisions agreed 2026-10-15 (Ctrl+S, hint only with text, per project, no pop on empty). Footer mockup awaiting approval. Nothing built.

**Idea:** park the half-typed prompt with one key, clear the input, and bring it back later. Popping removes it from the list (git-stash semantics). Ported from the `stash` built-in on `main` (`packages/agent/extensions/stash`), reshaped for Tau.

## How `main` does it

| Part | Behavior |
| --- | --- |
| Stash key | Alt+S: trims the editor text, appends `{ id, text, createdAt }`, clears the editor. Empty editor: nothing. Same text already stashed: "Already stashed." |
| `/pop` | Browser, newest first with age; type to filter; Enter puts the text in the editor (not sent) and removes it; Ctrl+D discards after confirming |
| Store | `~/.pi/tau/stash.jsonl`, one list for all repos and sessions |

## `/pop` list (mockup, awaiting approval)

Uses the existing picker: label is the first line of the draft, note is the age, detail is the rest of the draft on one line. Type to filter. Newest first.

```text
Stash
────────────────────────────────────────────────────────────
▸ fix the flaky reconnect test (2m)  and check why the retry backoff…
  rename Stash to Parked in the docs (1h)  also the guide page
  explain how the sidebar drawer… (yesterday)  gets its width
────────────────────────────────────────────────────────────
filter…
enter pop · ctrl+d discard · esc close

filtered by "sidebar"        one row left, same layout
empty                        No stashed prompts. Press ctrl+s with text in the input.
ctrl+d                       list swaps to the selected stash alone; hint: discard this stash? enter discard · esc keep
                             (a replacement picker with `back` returning to the list, as /references does)
after enter                  list closes, input holds the draft (not sent), stash removed
```

## Proposed Tau shape

| Topic | Proposal |
| --- | --- |
| Stash | Ctrl+S, bound to a `prompt.stash` command in the input's key layer (`keymap.ts`, priority `input`), next to `prompt.queue` and `input.clear` |
| Pop | `/pop` slash command opens a `Picker` (`Picker.tsx`, as `/references` does) listing stashes; Enter fills the input and removes the stash |
| Core | A `Stash` service in `src/core/` (like `FavoriteModels.ts`) with `add`, `list`, `remove`; the TUI only calls it |
| Store | A new `stash.db` in Tau's home, opened with `openDatabase` (as `sessions.db` and `credentials.db` are), with a `project` column: one list per project (differs from `main`, which shares one list) |
| Footer | Hide `chat.quit` from the idle hints (`InputFooter.tsx`, `IDLE_HINTS`) and show `ctrl+s stash` when the input has text; the quit hint returns when it is empty. Ctrl+D still quits. The stash key on an empty input does nothing |

Footer while the input has text (mockup to approve before building):

```text
before   claude-x (high)        enter send · shift+enter new line · ctrl+b sidebar · ctrl+d quit
after    claude-x (high)        enter send · shift+enter new line · ctrl+b sidebar · ctrl+s stash
```

