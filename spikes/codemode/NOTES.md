# Code mode

**Question:** can `@opencode/codemode` (2.0.27, MIT) replace QuickJS as the interpreter behind Tau's `run` tool? It passes if it runs from a compiled binary, Esc stops a busy loop while the event loop keeps ticking, it shares one copy of Effect 4.0.3 with Tau, and real scripts models wrote run unchanged.

**Answer: yes.** Bun 1.4.3, Effect 4.0.3, macOS arm64.

## Setup

- `package.json` pins `@opencode/codemode` 2.0.27 and `effect` 4.0.3 with an `overrides` entry. The package asks for Effect 4.0.1 exactly; the override installs a single 4.0.3 copy, and everything below ran on it.
- `host.ts` defines two tools with Effect Schemas: `sh` (`Bun.spawn`, killed through the interruption signal) and `read`. Esc is `Fiber.interrupt` on the running program.
- `corpus.ts` reads every `codemode` tool call from local Pi sessions (`~/.pi/agent/sessions`) and runs the 496 distinct scripts with stub tools and stub Pi globals (`text`, `image`, `store`, `load`, `exit`). It also parses each script with acorn and looks for syntax the interpreter lists as unsupported. It writes nothing.
- Build: `bun build --compile host.ts --outfile dist/codemode`, run with `node_modules` moved away and `PATH=/usr/bin:/bin`.

## Results

`host.ts`, the same under `bun` and the compiled binary:

| Case | Result |
| --- | --- |
| Chained awaits, three `sleep 0.2` calls in `Promise.all`, try/catch around a failing read | Pass, ~235 ms total, so host calls run concurrently |
| Esc while awaiting `sleep 5` | Run ends in ~203 ms; the child is killed, no orphan |
| Esc during `while (true) {}` on the main thread | Ends in ~302 ms; the event loop ticked 29–30 times in those 300 ms, so the UI keeps drawing without a worker |
| `timeoutMs: 300` on a busy loop | `TimeoutExceeded` at ~301 ms |
| One million loop iterations | 1.1–1.3 s, about 50 times slower than QuickJS (24 ms) |
| Tau's Schema in `Tool.make`, given a wrong input type | `InvalidToolInput`: one Effect copy works across the boundary |

Compiled binary: 72 MB.

`corpus.ts` on 496 scripts: 438 ran to completion. 55 failed only because the stubs returned empty strings (`JSON.parse` of `""`, reading a property of `null`), and one used Pi's `models` global, which had no stub. The 3 parse errors are scripts JavaScriptCore also rejects. **No script used unsupported syntax**, by the run or the static scan (classes, getters and setters, BigInt, user-defined constructors).

## Takeaways

- No worker, no WASM file, no message channel. The interpreter runs as Effect fibers that yield to the event loop, so Esc and timeouts stop busy loops on the main thread. The sandbox spike's untested worker request-and-reply channel is no longer needed.
- Tools are `Tool.make` with Effect Schemas, matching the SDK's public types. `before` and `after` hooks wrap every call.
- Pin the version and keep the `effect` override until the package's Effect pin matches Tau's.
- The cost is speed on CPU-heavy scripts. Scripts are mostly glue between tool calls, so it does not matter for the corpus.

## Not tested

- Linux.
- Stub tools cut 53 scripts short, so the runtime check did not reach their later lines; the static scan covers them for syntax only.
- Missing built-ins reached only in later lines, Pi's `models` global, memory limits, and large outputs.
