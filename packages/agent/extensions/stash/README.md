# Stash

Park a half-typed prompt without leaving the keyboard, then pop it back into the
editor later. Mirrors the storage shape of `ideas` but with git-stash
semantics: popping removes the item from the list.

## Usage

```text
stash shortcut  Stash whatever is in the prompt editor (TUI only; check Pi keybindings)
/pop            Browse stashed prompts and pop one into the editor (TUI)
```

## Behavior

- Stashed prompts are stored for the user at `~/.pi/tau/stash.jsonl`, shared
  across repos and pi sessions.
- The stash shortcut reads the current editor text, trims it, and appends a
  record `{ id, text, createdAt }`. It then clears the editor so you can type a
  different prompt. Nothing happens if the editor is empty.
- Identical text already in the stash is skipped (no duplicate entries) and the
  stash key reports "Already stashed."
- `/pop` opens a native TUI browser. Stashes are shown newest-first with a
  relative age.
- Browser keys:
  - type to filter (case-insensitive substring)
  - `↑` / `↓` move selection
  - `enter` pop the selected stash into the prompt editor (raw, not submitted)
    **and remove it from the store**
  - `ctrl+d` discard the selected stash without restoring it (confirms first)
  - `esc` / `ctrl+c` cancel
- Pops are not auto-submitted; you stay in control of the prompt. To return a
  popped prompt to the list, stash it again.

## Why this exists

Stashing lets you bail out of a draft to handle something urgent without losing
the text, and keeps the parking lot short by removing items when they're
restored rather than leaving them to accumulate.

## Limits

- The stash keybinding and `/pop` browser are TUI-only; there is no print/JSON/
  RPC path (the whole point is interacting with the prompt editor mid-type).
- The store file lives in the user's home directory and is not part of the
  repo.
- Mutations rewrite the whole file (atomic temp + rename); safe for single-user
  TUI use, not designed for concurrent writers.
