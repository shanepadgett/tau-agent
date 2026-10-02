# Script Runner

Gives the agent a first-class `script_runner` tool for running Python 3, Node.js, and Deno code. The agent uses dedicated tools for ordinary reads, searches, and edits, and uses concise read-only shell commands and tools such as `rg`, `find`, and `jq` to filter output at the source. Custom Python, Node, or Deno logic—including one-off calculations, parsing, transformations, and automation—runs through `script_runner`, not through bash snippets, heredocs, or temporary source files. Bash remains useful for direct shell commands, existing project commands, and tasks that genuinely need shell-specific behavior.

When a run fails, the tool keeps the script and returns a `scriptId`. The agent retries with targeted `{oldText, newText}` edits against what it just wrote instead of resending the whole script, saving output tokens and keeping duplicate scripts out of context. Only the source the agent already sent is referenced; no script source file path is exposed.

Long output shows the tail and a path to the complete output in a temporary file for the active session.

Runtimes are detected from the environment: Python 3 via `python3`, Node via the current process when Node is 22.6 or newer (`node --experimental-strip-types`), Deno via `deno` (`deno run -A`). The `node` language is the local Node.js runtime with full Node APIs; scripts may be TypeScript with erasable syntax or plain JavaScript. The `deno` language is the local Deno runtime with full permissions and native TypeScript/JavaScript. The tool registers only the runtimes actually available and is hidden from the prompt entirely when none are present.
