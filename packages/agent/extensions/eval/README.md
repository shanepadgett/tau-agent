# Eval

Gives the agent a first-class `eval` tool for running Python 3 and Node.js code. The agent uses dedicated tools for ordinary reads, searches, and edits, and uses concise read-only shell commands and tools such as `rg`, `find`, and `jq` to filter output at the source. Custom Python or Node logic—including one-off calculations, parsing, transformations, and automation—runs through `eval`, not through bash snippets, heredocs, or temporary source files. Bash remains useful for direct shell commands, existing project commands, and tasks that genuinely need shell-specific behavior.

When a run fails, the tool keeps the script and returns a `scriptId`. The agent retries with targeted `{oldText, newText}` edits against what it just wrote instead of resending the whole script, saving output tokens and keeping duplicate scripts out of context. Only the source the agent already sent is referenced; no script source file path is exposed.

Long output shows the tail and a path to the complete output in a temporary file for the active session.

Code previews show the first 10 source lines with syntax highlighting while the agent writes the call. Expand the tool row to see all received code. Retry previews show removed and added lines with the same preview limit. Results appear below a spaced Output or Error divider, separate from the code preview and its overflow count. Input and output keep separate line counts, with one expansion hint at the end of the completed result when either preview hides lines.

Each call runs in a fresh process; variables and imports do not persist between calls.

Runtimes are detected from the environment: Python 3 via `python3`, Node via the current process when Node is 22.6 or newer (`node --experimental-strip-types`). The `node` language is the local Node.js runtime with full Node APIs; scripts may be TypeScript with erasable syntax or plain JavaScript. The tool registers only the runtimes actually available and is hidden from the prompt entirely when none are present.
