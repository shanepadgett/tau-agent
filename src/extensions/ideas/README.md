# Ideas

Capture rough, unrefined ideas for the current repository without polluting
planning folders or committed docs. Log from anywhere, browse and act on them
in the TUI.

## Usage

```text
/ideas <text>     Log a rough idea (works in any mode)
/ideas            Browse ideas (TUI only)
```

## Behavior

- Ideas are stored per repo at `.pi/tau/ideas.jsonl`, resolved from the project
  root (via git toplevel or `.pi/tau/`), so the file is stable regardless of the
  cwd pi was launched from.
- `/ideas <text>` appends a record `{ id, text, createdAt }` and works in print,
  JSON, RPC, and TUI modes.
- `/ideas` opens a native TUI browser. Ideas are shown newest-first with a
  relative age.
- Browser keys:
  - type to filter (case-insensitive substring)
  - `↑` / `↓` move selection
  - `enter` insert the selected idea's text into the prompt editor (raw, not
    submitted) so you can shape it into a request before sending
  - `ctrl+e` edit the selected idea in the native multiline editor
  - `ctrl+d` delete the selected idea (confirms first)
  - `esc` / `ctrl+c` cancel
- Inserts are not auto-submitted; you stay in control of the prompt.

## Why this exists

Rough ideas are not plans. Keeping them out of `docs/plans/` (and out of any
planning workflow) prevents half-formed thoughts from being treated as committed
work. This is the parking lot for them.

## Limits

- The browser renders the full filtered list with no viewport windowing; very
  large idea stores may overflow short terminals. Use search and `ctrl+d` to
  manage size.
- The store file lives in the repo. Gitignore `.pi/tau/ideas.jsonl` (or `.pi/`)
  if you do not want rough notes committed or shared.
- Mutations rewrite the whole file (atomic temp + rename); safe for single-user
  TUI use, not designed for concurrent writers.
