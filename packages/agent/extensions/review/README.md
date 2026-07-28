# Review

Run `/review` to inspect current repository's staged, unstaged, and untracked work in a fresh isolated session. Choose one focused pass:

- `simplify` looks for code and concepts that can disappear or reuse what already exists.
- `architecture` performs a nuclear maintainability review and accepts substantial redesign when ownership, reuse, or structure is poor.
- `correctness` checks runtime bugs and failures after architecture is accepted.

Run a mode directly with `/review simplify`, `/review architecture`, or `/review correctness`. Run `/review show` to reopen latest result on current session branch.

Results stay outside parent agent context. In result view, press `a` to send review to agent's next turn or `e` to export Markdown under `.pi/tau/reviews/`.
