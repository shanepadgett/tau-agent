# Script Runner

Gives the agent a first-class `script_runner` tool for running Python 3, Node.js, and Deno scripts instead of falling back to bash. The agent picks whichever runtime is more efficient for the task.

When a run fails, the tool keeps the script and returns a `scriptId`. The agent retries with targeted `{oldText, newText}` edits against what it just wrote instead of resending the whole script, saving output tokens and keeping duplicate scripts out of context. Only the source the agent already sent is referenced; no file path is exposed.

Runtimes are detected from the environment: Python 3 via `python3`, Node via the current process when Node is 22.6 or newer (`node --experimental-strip-types`), Deno via `deno` (`deno run -A`). The `node` language is the local Node.js runtime with full Node APIs; scripts may be TypeScript with erasable syntax or plain JavaScript. The `deno` language is the local Deno runtime with full permissions and native TypeScript/JavaScript. The tool registers only the runtimes actually available and is hidden from the prompt entirely when none are present.
