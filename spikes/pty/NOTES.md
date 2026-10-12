# Process sessions

**Answer: yes, with explicit cleanup.** Bun 1.4.3, macOS and Linux arm64. No PTY helper binary or npm dependency needed.

Build from the repo root: `bun build --compile spikes/pty/host.ts --outfile spikes/pty/dist/tau`. Run `./spikes/pty/dist/tau`. `PYTHON` can select a Python executable; the default is `/usr/bin/python3`.

Verified the compiled binary from `/` with PATH `/usr/bin:/bin`:

- Interactive bash accepts input; stdin, stdout and stderr are TTYs.
- `terminal.resize(120, 40)` changes `stty size` from `24 80` to `40 120`.
- Interactive Python reports TTYs and answers `6 * 7` with `42`.
- A background HTTP server stays alive across two separate simulated tool calls.
- Cleanup stops a job-control shell, server, nested shell, and sleep process across three process groups. All four PIDs disappear and the server port closes.

Create `Bun.Terminal`, pass it to `Bun.spawn` with `detached: true`, and use `write`, `resize` and the `data` callback. Always close the terminal after the process exits.

**Isolation matters.** Without `detached: true`, the PTY children shared the host's process group and Python cleanup terminated the spike with exit code 143. With it, each root gets its own group and the complete experiment passes.

**One process-group kill is not a tree kill.** Interactive shell job control puts background jobs in separate groups. The spike snapshots descendants using `ps`, terminates children while their parents can reap them, escalates surviving children to SIGKILL, then terminates the root. This proves cleanup for the tested tree, not a race-free production supervisor. Production needs ownership tracking and must handle new descendants during cancellation. Deliberately daemonized/reparented children and host crashes are not covered.

Optional interactive OpenTUI experiment: set `TAU_TUI` to its compiled binary and `TAU_TUI_EXTENSION` to `ext/clock.tsx`, both absolute paths. Verified startup, prompt input, a streamed reply, sidebar extension, and Ctrl-C exit with no OpenTUI dependencies present.

macOS binary: 68 MiB. Core experiment: 2.7 seconds; with the OpenTUI experiment: 3.7 seconds.

## Linux

Passed in a temporary OrbStack Docker container using `oven/bun:1.4.3` (Debian 13 arm64), with `--init` and bash, Python 3 and procps installed. Sources were mounted read-only and copied into the container; the binary was compiled there and run from `/` with PATH `/usr/bin:/bin`. The container was removed afterward.

All existing assertions passed: shell/Python input and TTYs, resize, server persistence, four-process cleanup across three groups, and server port closure. The optional interactive OpenTUI test also passed without its `node_modules`. Linux binary: 87 MiB; combined experiment: 3.4 seconds.

The first run exposed a test-formatting issue: Linux bash emitted a bracketed-paste escape sequence before `READY`, interrupting the expected raw newline sequence. Printing a leading newline before the marker fixed the assertion without changing PTY behavior.

Not tested: heavy output/backpressure, 64 sessions, the production head/tail buffer, or Linux x64/musl.
