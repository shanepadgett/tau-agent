# Reference

Select local reference repositories, add new ones, and send a prompt that points Tau at them.

## Usage

```text
/reference
/reference new <git-url>
```

## Behavior

- Stores references in `~/.local/share/tau-agent/references/`.
- `/reference` opens a TUI picker.
- `/tau-new` and `/tau-edit` can reuse the picker to attach reference paths.
- `n` adds a new reference from a git URL, then lets you choose the branch before cloning.
- `u` runs `git pull --ff-only --quiet` in each reference without closing the picker, showing `…`, `✓`, or `!` next to each name.
- `o` opens the highlighted reference in an editor. Defaults to `$VISUAL`, `$EDITOR`, then `code`; settings can force `code` or `zed`.
- `d` deletes the selected references from disk (with confirm). Disabled with nothing selected.
- Space selects references; Enter opens an editor for the request.
- Sends the request with selected reference paths in the chat.

## Settings

```json
{
  "extensions": {
    "reference": {
      "editor": "default"
    }
  }
}
```

`editor` can be `default`, `code`, or `zed`.

## Limits

- Requires TUI mode for the picker.
- `/reference new <git-url>` works without the reference picker. In TUI mode it still asks which branch to clone.
- Uses the git URL basename as the folder name.
- References are treated as read-only examples by the generated prompt.
