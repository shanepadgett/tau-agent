# OpenTUI

**Answer: yes.** Bun 1.4.3, OpenTUI 0.6.1, Solid 1.9.12, macOS and Linux arm64.

The compiled binary renders a chat pane with streaming markdown, a code block, input, and a sidebar. A runtime `.tsx` extension imports the embedded SDK and Solid, imports a relative helper, and adds a reactive sidebar slot. Its timer and the host's token signal both update.

Build: `bun run build.ts` in this folder. Run: `./dist/tau --frame ext/clock.tsx` for the headless experiment, or omit `--frame` for the interactive app.

Verified from `/` with PATH `/usr/bin:/bin` and this folder's `node_modules` moved away. The native OpenTUI library and runtime JSX transform work without an external install. The binary is 82 MiB, versus about 68 MiB for the earlier minimal binaries. Runtime extension loading took 32 ms without dependencies present; setup plus the simulated streaming reply took 454 ms. These are single samples, not benchmarks.

Use `ensureRuntimePluginSupport({ additional: { "@shanepadgett/tau": sdk } })` before loading extensions. It exposes the host's OpenTUI/Solid modules and transforms runtime JSX. Build the app with `@opentui/solid/bun-plugin`. `SyntaxStyle.fromStyles` needs `renderer.nativeScene` as its resource owner in 0.6.1.

The test renderer's `waitForFrame` stops when rendering goes idle; it does not wait for future timers. The spike explicitly waits and renders successive frames, and verifies that the submitted prompt appears before the reply.

Also verified the interactive renderer through the PTY spike: startup, typing a prompt, streamed reply, sidebar extension, and Ctrl-C exit. Both binaries ran from `/` with minimal PATH and no OpenTUI `node_modules` present.

## Linux

Passed in a temporary OrbStack Docker container using `oven/bun:1.4.3` (Debian 13 arm64). Sources were mounted read-only and copied into the container; dependencies and binaries were built there. The container was removed after the test.

Both headless rendering and the PTY-driven interactive app passed with `node_modules` moved away, cwd `/`, and PATH `/usr/bin:/bin`. The runtime `.tsx` extension remained reactive. Extension load: 31 ms; headless experiment: 560 ms. Linux binary: 106 MiB. These are single samples.

Not tested: terminal emulator compatibility, long-session memory, UI extension reload/cleanup, syntax-highlight colors (character captures discard colors), or Linux x64/musl.
