# Stash

Park a half-typed prompt without leaving the keyboard, then pop it back into the
editor later. Mirrors the storage shape of `ideas` but with git-stash
semantics: popping removes the item from the list.

## Usage

```text
ctrl+shift+s   Stash whatever is in the prompt editor (TUI only)
/pop           Browse stashed prompts and pop one into the editor (TUI)
```

## Behavior

- Stashed prompts are stored per repo at `.pi/tau/stash.jsonl`, resolved from
  the project root (via git toplevel or `.pi/tau/`), so the file is stable
  regardless of the cwd pi was launched from.
- `ctrl+shift+s` reads the current editor text, trims it, and appends a record
  `{ id, text, createdAt }`. It then clears the editor so you can type a
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
  popped prompt to the list, stash it again with `ctrl+shift+s`.

## Why this exists

Stashing lets you bail out of a draft to handle something urgent without losing
the text, and keeps the parking lot short by removing items when they're
restored rather than leaving them to accumulate.

## Limits

- The stash keybinding and `/pop` browser are TUI-only; there is no print/JSON/
  RPC path (the whole point is interacting with the prompt editor mid-type).
- The browser renders the full filtered list with no viewport windowing; very
  large stores may overflow short terminals. Use search and `ctrl+d` to manage
  size.
- The store file lives in the repo. Gitignore `.pi/tau/stash.jsonl` (or `.pi/`)
  if you do not want stashed drafts committed or shared.
- Mutations rewrite the whole file (atomic temp + rename); safe for single-user
  TUI use, not designed for concurrent writers.
