# Script Runner

Gives the agent a first-class `script_runner` tool for running Python 3 and TypeScript instead of falling back to bash. The agent picks whichever language is more efficient for the task.

When a run fails, the tool keeps the script and returns a `scriptId`. The agent retries with targeted `{oldText, newText}` edits against what it just wrote instead of resending the whole script, saving output tokens and keeping duplicate scripts out of context. Only the source the agent already sent is referenced; no file path is exposed.

Languages are detected from the environment: Python 3 via `python3`, TypeScript via Node with `--experimental-strip-types` (Node 22.6 or newer). The tool registers only the languages actually available and is hidden from the prompt entirely when neither is present.
