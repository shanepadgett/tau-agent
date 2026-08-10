# Review

Run `/review` without arguments to inspect the current repository's staged, unstaged, and untracked work in a fresh isolated session. This form stops when the working tree is clean.

Add review direction after the command to review the requested part of the repository instead, regardless of whether the working tree has changes:

```text
/review focus on cancellation, cleanup, and data loss
```

After the command, choose which logged-in provider runs the review. OpenAI Codex uses `gpt-5.6-sol` and Anthropic uses `claude-opus-5`, both at high thinking. Only providers you are logged in to appear. With no logged-in provider, the review uses the current model.

Tau writes each result as Markdown under `.pi/tau/reviews/`. Review results do not enter the parent agent context. Reference the Markdown file later when you want an agent to use it.
