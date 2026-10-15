# Keys and input

The footer shows the keys that work now. These are the ones it does not explain:

| Key | Does |
| --- | --- |
| Enter | Sends. During a run it steers: the model reads it at its next call. |
| Tab | During a run, queues the prompt to run after it |
| Shift+Tab | Steps the thinking level |
| Ctrl+J | New line (Shift+Enter and Ctrl+Enter need the kitty keyboard protocol) |
| Ctrl+C | Closes a list, clears the input, cancels the run, then quits |
| Ctrl+B | Shows or hides the sidebar (twice in tmux) |
| Ctrl+S | Stashes the input |

Cancelling a run puts waiting prompts back in the input. Keys cannot be changed yet.

**`@`** tags a file, folder or reference by path, from a list that matches loosely. The model gets the path, not the contents. Add `#L10-20` for lines. Search is off in your home folder.

**Pictures**: paste with Ctrl+V, drop a file, or tag one with `@` (PNG, JPEG, WebP, GIF, BMP). Each shows as `[Image N]`. A model without image support gets a note instead. On Linux, install `wl-paste` or `xclip`.

**Sidebar** (Context, Cost, Processes, Compaction, References): beside the chat at 122 columns or wider, remembered in `~/.tau/tui.json`; narrower, it opens over the chat and starts closed.

**Copy**: select text with the mouse. Over SSH the terminal must allow OSC 52.
