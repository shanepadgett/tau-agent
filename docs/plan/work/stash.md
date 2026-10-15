# Stash and pop

Status: under discussion 2026-10-15. Nothing built.

**Idea:** park the half-typed prompt with one key, clear the input, and bring it back later. Popping removes it from the list (git-stash semantics). Ported from the `stash` built-in on `main` (`packages/agent/extensions/stash`), reshaped for Tau.

## How `main` does it

| Part | Behavior |
| --- | --- |
| Stash key | Alt+S: trims the editor text, appends `{ id, text, createdAt }`, clears the editor. Empty editor: nothing. Same text already stashed: "Already stashed." |
| `/pop` | Browser, newest first with age; type to filter; Enter puts the text in the editor (not sent) and removes it; Ctrl+D discards after confirming |
| Store | `~/.pi/tau/stash.jsonl`, one list for all repos and sessions |

## Proposed Tau shape

| Topic | Proposal |
| --- | --- |
| Stash | A key bound to a `prompt.stash` command in the input's key layer (`keymap.ts`, priority `input`), next to `prompt.queue` and `input.clear` |
| Pop | `/pop` slash command opens a `Picker` (`Picker.tsx`, as `/references` does) listing stashes; Enter fills the input and removes the stash |
| Core | A `Stash` service in `src/core/` (like `FavoriteModels.ts`) with `add`, `list`, `remove`; the TUI only calls it |
| Store | Under Tau's home (`src/database/TauHome.ts`), shared across projects, as on `main` |
| Footer | Hide `chat.quit` from the idle hints (`InputFooter.tsx`, `IDLE_HINTS`) and show the stash key when the input has text. Ctrl+D still quits; Ctrl+C on an empty input also quits |

Footer while the input has text (mockup to approve before building):

```text
before   claude-x (high)        enter send · shift+enter new line · ctrl+b sidebar · ctrl+d quit
after    claude-x (high)        enter send · shift+enter new line · ctrl+b sidebar · alt+s stash
```

## Not decided

See `questions.md`, "Stash and pop".
