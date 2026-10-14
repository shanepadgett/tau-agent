# Leave a command running

Process sessions let the agent start a dev server, a watcher or a REPL, leave it running, and come back to it in a later script or run.

The agent uses the `process` functions inside `run`. You do not call them yourself.

1. Start the command: `const server = await tools.process.start({ command: "bun run dev" });`. It waits 1 second by default (`waitSeconds`, from 0.25 to 30) and returns `id`, `reason`, the output so far and, if the command already exited, `exitCode`.
2. For a program that needs a terminal, such as a REPL or a prompt, pass `pty: true`.
3. Wait for what you need: `await tools.process.wait({ id: server.id, pattern: "listening on", deadlineSeconds: 20 });`. It returns when the process exits, a line matches `pattern` (a regular expression), `quietSeconds` (default 30) pass without new output, or the deadline ends, whichever comes first.
4. Read new output with `await tools.process.read({ id })`, or everything the session kept with `await tools.process.readAll({ id })`.
5. Send input with `await tools.process.write({ id, text: "1 + 1\n" });`.
6. See every session with `await tools.process.list({})`.
7. Stop a session and everything it started with `await tools.process.kill({ id })`.

## What happens

Each command runs through `sh -c` in the session's directory. With pipes (the default) the output is clean lines. With `pty: true` the output keeps the escape codes a terminal prints.

A process session belongs to the Tau session, not to the script or the run. It keeps running after the script and the run end, and a script that times out does not kill it. It ends when the command exits, when the agent kills it, or when you close the session, switch away from it or exit Tau. Closing it kills the whole process tree.

`read` returns the output since the last read. `wait` returns the same, and when nothing new arrived it also returns `tail`, the last lines, so a hung command is visible. Each session keeps up to 1 MiB of output; past that it keeps the start and the end and marks the dropped part.

When a session exits by itself while the agent works, the agent gets one hidden notice with the exit code and the last output before its next model call. A session the agent killed gives no notice.

A checkpoint saves the running sessions. The agent's next view lists them (id and command) after the handoff.

## Limits

- At most 64 sessions at once. `start` fails when the limit is reached.
- A `wait` inside a script never outlasts the script's own timeout (10 minutes by default); the script ends first and the process keeps running.
- Sessions do not survive Tau exiting. There is no way yet to attach to a session from the terminal or list them in a sidebar.
- A command that starts new processes while a PTY session is being killed can leave them running.
