# Effect

**Question:** should Tau's internal layers use Effect 4 instead of plain promises, `AbortSignal` and `try/finally`?

**Answer: Effect works and costs almost nothing at runtime. Its gain is cancellation that reaches every await without threading a signal.** Bun 1.4.3, effect 4.0.3, macOS arm64.

## What was tried

The same two pieces written twice, plain TypeScript in `plain/` and Effect in `fx/`, run by the same checks:

- **Provider stream:** POST to a local fake Anthropic server, decode SSE split into 7-byte reads, and feed one pure reducer (`shared/anthropic.ts`: `initial`, `step`, `end`). Checks: complete message, truncated body, HTTP 500, consumer stops early, cancel mid-stream, 20k deltas.
- **PTY session:** `Bun.Terminal` running an interactive bash that starts a job-control tree (4 processes), then tree kill (SIGTERM children, SIGKILL survivors, then the root). Checks: kill on normal scope exit and on abort mid-call.

Run: `bun install`, then `bun plain/main.ts` or `bun fx/main.ts`. Compile: `bun build --compile --minify fx/main.ts --outfile dist/tau-fx`. Both compiled binaries pass from `/` with PATH `/usr/bin:/bin`. Two negative controls confirm the checks catch leaks: without `reader.cancel()` in the plain decoder the connection stays open after `break`; with a no-op Effect release the four processes survive.

## Result

| | Plain | Effect |
| --- | --- | --- |
| Stream lines | 45 (hand-written SSE parser) | 15 (`HttpClient`, `Sse.decode`, `Stream.mapAccum`) |
| Session lines | 44 | 36 |
| Cleanup | `await using` + `Symbol.asyncDispose` | `Effect.acquireRelease`, release uninterruptible |
| Cancel reaches waits | only where the signal is passed in | every `yield*` |
| Minified bundle | 6 KB | 92 KB (31 KB gzip) |
| Compiled binary | 70.86 MB | 70.95 MB |
| 20k-delta stream | ~70 ms | ~72 ms |

- Most of the stream line gap is Effect's built-in SSE decoder; a small SSE library would close it.
- In plain code, each cleanup is a separate thing to remember: `reader.cancel()` in `finally`, passing `abort` into every wait loop, `await using` at each call site. Forgetting one leaks silently. In Effect, `Stream.take`, `Effect.timeout`, breaking out of `Stream.toAsyncIterable`, and `Effect.runPromise(effect, { signal })` all closed the connection or killed the tree with no extra code.
- A promise facade works: `Stream.toAsyncIterable` and `runPromise({ signal })` let the SDK stay plain promises.
- Writing it: the package ships `AGENTS.md` and `ai-docs/` examples. Guided by those, the Effect files typechecked on the first `tsc` run. One wrong `pipe` was caught before compiling. The plain version hit one DOM lib typing error (`TextDecoderStream`).

## Limits

- `effect/http` and `effect/encoding` (HTTP client, SSE) are marked `@stability unstable` in 4.0.3; `Effect`, `Stream` and `Scope` are stable. Plain `fetch` wrapped in `Stream.fromReadableStream` avoids the unstable modules.
- `HttpClientError` for a 500 does not include the response body; real provider errors need it.
- Small code only. Layers, services, typed error channels and Schema were not exercised. Neither were stack traces, debugging, or the cost of every contributor and agent learning Effect.
- macOS only; Linux not run.
