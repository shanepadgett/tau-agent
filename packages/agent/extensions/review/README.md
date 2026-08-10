# Review

Run `/review` to inspect the current repository's staged, unstaged, and untracked work in a fresh isolated session. Add any review direction after the command:

```text
/review focus on cancellation, cleanup, and data loss
```

Without direction, the agent performs a general correctness and maintainability review. After the command, choose which logged-in provider runs the review. OpenAI Codex uses `gpt-5.6-sol` and Anthropic uses `claude-opus-5`, both at high thinking. Only providers you are logged in to appear. With no logged-in provider, the review uses the current model.

Tau writes each result as Markdown under `.pi/tau/reviews/`. Review results do not enter the parent agent context. Reference the Markdown file later when you want an agent to use it.
