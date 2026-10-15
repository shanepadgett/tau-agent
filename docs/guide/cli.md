# Command line

| Command | Does |
| --- | --- |
| `tau [prompt]` | Opens the chat, optionally sending a first prompt |
| `tau -p [prompt]` | Runs one prompt and exits. Without a prompt, reads stdin. |
| `tau login`, `tau logout` | Saves or removes a provider login |

| Flag | Does |
| --- | --- |
| `--session <id>` | Continues a session. Tau prints `Session: <id>` when it ends. |
| `--model provider/model` | Model for this run |

In print mode the answer goes to stdout and script lines go to stderr. The exit code is not 0 when the run fails, reaches `maxTurns`, hits the model's output limit, repeats the same failing call 3 times, or ends with failing project checks.

Output over 50 KB or 2,000 lines is cut to its start and end and saved in `$TMPDIR/tau/<session>/`, which Tau never deletes. Rate limits and server errors are retried 4 times. A plan usage limit (Claude, ChatGPT) is not retried; the message gives the reset time.
