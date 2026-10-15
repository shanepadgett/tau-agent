# Stash a prompt for later

Stash a half-written prompt to deal with something else first, then bring it back.

1. Type a prompt and press Ctrl+S. Tau saves the text and clears the input. The transcript says "Stashed." If this folder already has a stash with the same text, it says "Already stashed." and leaves the input as it is.
2. When you want it back, type `/pop` and press Enter. The list shows this folder's stashes, the latest first: the first line of the prompt, its age (`now`, `5m`, `3h`, `2d`) and the rest of the prompt muted. Type to filter.
3. Press Enter on a stash. Tau puts its text in the input and removes it from the list. It does not send it. If the input already holds text, the stash goes after it, separated by a blank line.
4. To drop a stash, press Ctrl+D on it. Tau asks first: Enter discards it, Escape keeps it.

With nothing stashed, `/pop` says so. Ctrl+S on an empty input does nothing.

## Limits

- Each folder has its own stashes. Tau keeps them in `~/.tau/stash.db`.
- A stash keeps text only, not the cursor.
