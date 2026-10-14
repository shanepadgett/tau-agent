# Use checkpoints

Checkpoints let the agent continue a long session from a session memory, background notes, recent messages and a handoff while the original entries stay in storage.

1. Run Tau with compaction enabled (the default): `tau -p "Work on the next part of this project."`.
2. Continue the same session with `tau -p --session SESSION_ID "Continue."`.
3. To change the context budget or turn compaction off, edit the `compaction` block in `~/.tau/settings.json` and restart Tau. See [Change Tau's settings](settings.md).

## What happens

Past 50000 context tokens, a cheap model writes notes in the background. It receives earlier notes and the complete user messages, assistant messages, tool calls and results, instructions and nudges in each new range. The chat does not wait for it.

When the saved notes that no memory covers pass about 30000 tokens, the same model folds the oldest of them into a session memory of at most about 4000 tokens. The newest notes, about 8000 tokens, stay as notes. The memory keeps user preferences and corrections, decisions and reasons, project facts and unfinished work; a later fact replaces an earlier one. Each memory builds on the one before it, and the source notes and entries stay in storage.

The agent calls `checkpoint` alone with a handoff of at most 24000 characters. Its next model call uses the newest memory saved at that point, the notes after it, the entries not yet noted and the handoff. Notes and memory that finish later take effect at the next checkpoint, so the context between checkpoints does not change.

Hidden nudges tell the agent when context reaches half the budget, three quarters and the full budget. An announced stage stays active until the next checkpoint, even if a later token report lowers the estimate. At the full budget, every tool call except `checkpoint` fails until a checkpoint reduces the context. The tool list remains the same.

Notes show their entry ranges. The agent can recall their full transcript inside `run` with `await tools.history({ from: 12, through: 40 })`. Run output limits still apply to what it prints or returns.

## Limits

Background notes and memory use `claude-haiku-5-5` on Anthropic and `gpt-6-luna` on the other built-in routes (`openai/gpt-6-luna` on OpenRouter). If the route does not list that model, notes use the session model on the same route. Note and memory requests incur model usage.

A cancelled, failed or empty note or memory is not saved. The next completed tool call or run tries again. Closing Tau cancels unfinished background work; reopening the session resumes from the last saved note or memory.

Automatic overflow recovery and a manual `/compact` command are not built yet. Token estimates between provider reports are approximate.
