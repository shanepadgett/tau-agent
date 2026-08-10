# Review

Run `/review` to inspect current repository's staged, unstaged, and untracked work in a fresh isolated session. Choose one focused pass:

- `simplify` looks for code and concepts that can disappear or reuse what already exists.
- `architecture` performs a nuclear maintainability review and accepts substantial redesign when ownership, reuse, or structure is poor.
- `correctness` checks runtime bugs and failures after architecture is accepted.

Run a mode directly with `/review simplify`, `/review architecture`, or `/review correctness`. Run `/review show` to reopen latest result on current session branch.

After the mode, choose which logged-in provider runs the review. OpenAI Codex uses `gpt-5.6-sol` and Anthropic uses `claude-opus-5`, both at high thinking. Only providers you are logged in to appear. With no logged-in provider, the review uses the current model.

Results stay outside parent agent context. In result view, press `a` to send review to agent's next turn or `e` to export Markdown under `.pi/tau/reviews/`.
