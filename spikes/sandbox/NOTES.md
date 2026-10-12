# Sandbox

**Question:** does QuickJS (`quickjs-wasi`, as used by Pi's codemode) run from a compiled `tau` binary with its WASM embedded? Can sandboxed scripts await async host functions, and can a run be cancelled?

**Answer: yes.** Bun 1.4.3, `quickjs-wasi` 3.6.2.

## Setup

- WASM is embedded with `import wasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" }` and read through `Bun.file(wasmPath)`. Compiled once per process with `WebAssembly.compile`; each run creates a fresh VM from the compiled module.
- Host functions `read`, `bash`, and `http` return QuickJS promises (`vm.newPromise()`), settle them when the host work finishes, then call `vm.executePendingJobs()`. A sync `log` collects output.
- A script is wrapped as `(async () => { … })()` and awaited with `vm.resolvePromise`, raced against an `AbortSignal`.
- Build: `bun build --compile host.ts worker.ts --outfile dist/tau`.

## Results

All results are the same under `bun run` and the compiled binary, run from `/` with only `/usr/bin:/bin` on PATH and with `node_modules` moved away (so the WASM is truly embedded).

| Case | Result |
| --- | --- |
| WASM compile | 2–5 ms per process |
| VM create | 0.6–5 ms per run |
| Chained awaits: read a file, bash, HTTP, three bash calls in `Promise.all`, try/catch around a failing read | All work. The three parallel `sleep 0.2` calls finish together (~0.2 s), so host calls run concurrently |
| Abort while awaiting `bash("sleep 5")` | Run ends at the abort (~200 ms). The child process is killed through `Bun.spawn`'s `signal`; no orphan `sleep` remains |
| `while (true) {}` on the main thread with a 300 ms deadline in `interruptHandler` | Interrupted at ~300 ms. The host event loop gets **zero** ticks while it runs |
| 1e6-iteration loop with the interrupt handler checking the clock every 1024 calls | 24 ms |
| `while (true) {}` in a `Worker`, interrupted through a `SharedArrayBuffer` flag set by the host at 300 ms | Interrupted at ~300 ms. The host event loop keeps ticking (27 ticks) |

## Takeaways

- Embedding and loading the sandbox in a compiled binary works with no files beside the binary.
- Async host functions are straightforward: one QuickJS promise per call, settled from the host, then drain pending jobs.
- **CPU-bound guest code blocks the host on the main thread**, including the TUI and Esc handling. Only a deadline inside `interruptHandler` can stop it there. Running the VM in a `Worker` keeps the UI responsive and lets Esc interrupt through a shared flag. Workers work in the compiled binary when passed as an extra entrypoint. The real build should run the sandbox in a worker, which means host functions cross a message channel (worker asks, host performs, host replies).
- Host-function settlements can arrive after a run ends (for example, a killed process rejecting late). The host must ignore them once the VM is disposed.
- Compiled binary size: 68 MB.

## Not tested

- Host functions called from inside a worker (the request and reply channel).
- Memory limits and large outputs.
- Passing structured values (objects, arrays) rather than strings across the boundary.
