# Live checks

Status: collecting, 2026-10-13. Run these with real models when the TUI exists; a failure becomes a fix then, not a blocker now.

Each check names what it covers, how to run it, and what passes. Remove a check when it passes; a failure moves to the plan of the fix.

| Built in | Check | How | Passes when |
| --- | --- | --- | --- |
| Slice 4c | Script edits and the write queue in daily use | real tasks in a project, on Claude and a ChatGPT plan route | failed scripts are fixed with small edits, not sent again whole; two edits to one file in a script both land |
| Instruction files and skills | `always: true` and `read-when` files, skills from each folder | a project with `.tau/instructions/` and `.agents/skills/`; ask for a task that needs one of each | `always` text is in the system prompt; the model reads the `read-when` file and calls the skill when the task matches |
| Slice 4d | Fixers | `.tau/checks.json` with a real formatter in `fix`; ask for an edit with bad formatting | the file ends up formatted; the model never sees the formatter's output |
| Slice 4d | The `checks` tool | a real lint or type check in `check`; ask for a change | the model calls `checks` before its final message, and fixes a failure it reports |
| Slice 4d | Checks at the end of a run | a change that breaks a check, and a model that ends its turn without calling `checks` | Tau runs the checks, the model gets the failure and fixes it, and the run ends `answered`; after 3 failed tries the run ends `checks-failed` |
| Slice 4d | Changes through `sh` | ask the model to change a file with a shell command, such as `sed -i` | the fixers and checks run on that file |
| Slice 4d | Repeat limit | the live model matrix (`bun spikes/live-models/check.ts`) | no model hits `repeated-call` on a task it can do; a model stuck on one failing call ends the run within 3 calls |
| Slice 4e | Shell output files and timeouts | ask for a long command result, a search for a line omitted from its preview, and a noisy command with a short timeout | the model searches the linked full log; timeout includes a usable preview and log path |
| Slice 4e | Script output files | ask for a result over 50 KB, then one past the interpreter's 10 MB returned-output limit | the model uses the saved file, reduces what it prints, and does not claim discarded script output is recoverable |
| Slice 4e | Combined check reports | several noisy failed checks, each under 50 KB, with a combined report over the cap | the model reads the combined-report file and command logs, fixes the failures, and reaches passing checks |
| Reload | Restart into changed code | run `bun src/cli/main.ts` in this repository, type a prompt without sending it, change a file in `src/` from another editor; then break a file, then fix it | the chat restarts within about a second with the same session and the unsent prompt; a broken file leaves the chat running and shows the first line of the reason in the status strip above the input, with the full reason in `~/.tau/logs`; the fix clears the line and restarts the chat |
| Diagnostics | Log files, failed runs, copy on select | in a chat, select text with the mouse and paste it elsewhere; make a run fail (such as a wrong API key), then send "try again"; then `rg -l <session-id> ~/.tau/logs` | the pasted text matches the selection; the failed run shows after a resume and the model knows the last run failed; `rg` finds the run's error with its cause |
