# Auto-Name

Names chat sessions automatically from the user's first prompt, in the background, while the agent works.

## Why

New sessions show up as their first message in the session selector. Auto-Name gives them a short, descriptive title without making the user run `/name` or interrupting the agent.

## How it works

- On the first user prompt, fires a background model call to summarize it into a short name.
- Sets the name with `pi.setSessionName()` when it resolves. The agent is never blocked.
- **Never overwrites an existing name** — a manual `/name` or a prior auto-name always sticks.
- The model may decline if the prompt is too short, ambiguous, or a bare command.
- Uses cheap fallback models (shared with `/commit`); a provider that fails is cooled down for both features.
- Cancels on session switch (`/new`, `/resume`, `/reload`) so a name is never written into the wrong session.

## Usage

No invocation needed. Load extension, then reload:

```text
/reload
```

Send a prompt; the session gets named within a few seconds. Rename anytime with `/name`.
