# Questions

Open questions for the user. Each is removed as soon as it is answered.

## Sidebar ([work/sidebar.md](work/sidebar.md))

1. Which key opens and closes it? Options: Ctrl-B (common in editors, but it is tmux's prefix), a leader key like OpenCode's Ctrl-X then B (adds a new key concept), or another.
2. Animate the toggle, and if so, how fast (about 150 ms with `outQuad` is the starting point)?
3. Open by default on wide terminals, and does Tau remember the last choice?
4. What goes in the first version: context use, cost, process sessions, compaction state, or a subset?
5. Minimum chat width before the sidebar becomes a drawer: fixed (OpenCode's is 120 columns for the whole screen), or a setting?
6. When an open docked sidebar becomes a drawer on resize, does the drawer stay open over the chat, or close until you widen again? Recommendation: close, and reopen docked when wide again, so a resize never covers the chat.
