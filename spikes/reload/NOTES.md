# Reload

**Question:** can a supervisor process restart Tau into new code when Tau is idle, hand the terminal from one child to the next cleanly, refuse broken code, and fall back to the last good build after a crash? This is the design in `docs/plan/reload.md`.

**Answer: yes.** Bun 1.4.3, OpenTUI 0.6.1, Solid 1.9.12, macOS arm64. Passed under `bun supervisor.ts` and as a compiled binary.

## Setup

- `app/`: a stand-in for Tau's TUI and core. A header shows the build and status, plus a transcript and an input. A submitted prompt is a 2-second fake run. It talks to the supervisor over Bun IPC: `ready`, `idle` and `draft` out; `notice` and `exit-for-restart` in. `--check` renders one frame headlessly with the test renderer.
- `supervisor.ts`: watches the source and bundles it with `Bun.build` into `work/builds/<n>/`. It runs the candidate's `--check` and starts the child with the terminal inherited. It switches only when the child reports idle. A crashed build is restarted once, and a second crash within 10 s falls back to the last good build (a build that has been running for `STABLE_MS`). The unsent draft is streamed to the supervisor and passed to the next child.
- `drive.ts`: runs the supervisor in a `Bun.Terminal` PTY, reads the screen through `@xterm/headless`, and rewrites `work/app/version.ts` to simulate edits. After each exit, a shell records the exit code and `stty -a`.

Run `bun drive.ts`, or `bun build.ts && bun drive.ts dist/tau` for the compiled binary.

## Results

Times are from the compiled binary, from one run. `bun` runs differ by under 10 ms, except the first frame.

| Case | Result |
| --- | --- |
| First start | Frame after 1.2 s compiled, 0.5–0.6 s under `bun` (build 42 ms, check 290 ms) |
| Idle restart | Save to new frame: 552 ms (100 ms debounce, about 40 ms build, about 290 ms check, 105 ms switch). Screen shows no build for 98 ms. Draft kept |
| Edit during a run | Notice shown; switched 1 ms after the run ended |
| Syntax error | Build fails; old build keeps running; notice shown |
| Throws at start | Headless check fails; old build keeps running; notice shown |
| Crash (`SIGKILL`) after passing the check | Restarted once, crashed again, fell back to the last good build. Draft kept; input works |
| Ctrl-C quit | Supervisor exits 0; terminal restored |
| First build keeps crashing | Supervisor gives up with exit 1; terminal restored |
| Control: crashing build run alone | Terminal left in the alternate screen, with mouse tracking, bracketed paste and raw mode on |

## Findings for the build

- **Bundling OpenTUI needs two `Bun.build` options.** `external` must list the native packages of the other platforms (OpenTUI imports all of them). `publicPath` must be the build's absolute folder; otherwise the native library path resolves against the current folder. A build is 11 MB in 17 files, mostly tree-sitter grammars.
- **A compiled binary reads `bunfig.toml` from the current folder by default.** The binary failed in this folder (`preload not found "@opentui/solid/preload"`) until it was built with `autoloadBunfig: false`. Tau must set this. The children run as `BUN_BE_BUN=1 tau <bundle>` still read the folder's `bunfig.toml`. That worked here, but in Tau the folder is the user's project.
- **OpenTUI catches uncaught errors** and shows them in its console overlay instead of exiting. A thrown error does not crash the child; only a hard exit or a signal does.
- **The supervisor restores the terminal after a hard crash.** It writes the reset sequences for the screen modes. The raw terminal mode was also restored when the supervisor exited, most likely by Bun's own exit handling, since the supervisor never changes it. That cause was not tested separately.
- The supervisor ignores `SIGINT`, because Ctrl-C between two children reaches the whole process group.

## Not tested

Linux; Windows; a real Tau session and its SQLite reopen; resize during a switch; keys typed during the 100 ms gap; memory of many builds (old builds are never deleted here); a hang, which needs a watchdog; process sessions; and the source watcher on a large tree.
