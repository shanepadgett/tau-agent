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
- `n` adds a new reference from a git URL.
- `u` runs `git pull --ff-only --quiet` in each reference.
- Space selects references; Enter opens an editor for the request.
- Sends the request with selected reference paths in the chat.

## Limits

- Requires TUI mode for the picker.
- `/reference new <git-url>` works without the picker.
- Uses the git URL basename as the folder name.
- References are treated as read-only examples by the generated prompt.
