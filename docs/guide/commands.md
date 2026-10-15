# Slash commands

| Command | Does |
| --- | --- |
| `/commit [guidance]` | Runs the project's checks, plans conventional commits for every changed file, commits when you approve, then offers to push |
| `/model` | Chooses the model for this chat |
| `/new` | Opens a new session in this folder |
| `/pop` | Brings back a prompt stashed with Ctrl+S |
| `/qna [framing]` | Has the model ask its open questions in a panel and sends your answers back |
| `/references` | Attaches reference repositories (see [references.md](references.md)) |
| `/restart` | Restarts Tau into new code |
| `/sessions` | Opens an earlier session of this folder |

`/commit`, `/qna`, `/new` and `/sessions` wait for the run to end.

`/commit` needs a git repository. If a check fails or changes files, nothing is committed and the model gets the failures. The plan comes from the provider's small model; you cannot edit it, so cancel and rerun with guidance. Settings: `commit.push`, `commit.avoidBreakingChanges`.

Stashes are per folder and keep text only.
