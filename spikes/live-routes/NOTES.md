# Live routes

**Question:** do Tau's own route code, token refresh and decision adapters work against the live services, with the credentials `tau login` saved in `~/.tau`?

**Run:** `bun spikes/live-routes/check.ts [full|chat|codex-stream] [--identity] [--claude-headers]`. Each run writes `results-<mode>.json` beside the script (gitignored: it holds account IDs from response headers). The script imports `src/` directly. It deliberately rewrites `~/.tau/credentials.db`: `full` marks each subscription's tokens expired to force a real refresh.

## Results (2026-10-12, macOS arm64, under `bun`)

| Check | Result |
| --- | --- |
| ChatGPT subscription chat (`gpt-6-luna`) | Pass. |
| ChatGPT refresh | Pass. Expired tokens refreshed on the next request; access and refresh tokens both rotated; expiry moved ten days ahead. |
| Claude subscription chat (`claude-sonnet-5-5`) | **Failed with 429 `rate_limit_error`** (`"message": "Error"`, no rate-limit headers) unless the request carries both the Claude Code identity as the first system message and the headers `user-agent: claude-cli/2.1.280` and `x-app: cli`. Either one alone still fails. Pi sends both. Spike 8 sent the identity but not the headers, and passed then. Fixed in `src/ai/claude-code.ts`; passes live without the flags. |
| Claude refresh | Pass. The stored expiry moved eight hours ahead, and a call with the refreshed token succeeds once the identity and headers are added. |
| Jev on OpenRouter (System One) | Pass. |
| Luna on OpenRouter (System One, `openai/gpt-6-luna-decisions`) | Pass. |
| Luna on OpenAI Decisions (`gpt-6-luna`) | Pass. |
| Codex non-streaming text (`generateText`) | **Empty text in 2 of 5 calls.** In those calls the `response.completed` event has `output: []`, while the answer arrived in `response.output_item.done`. Tau's `collectCodexStream` kept only the completed event's output. Fixed by building the output from the item events; 5 of 5 calls pass live, including two with an empty completed output. |

The `--identity` and `--claude-headers` flags reproduce the Claude fix by hand. Tau now adds both itself, so `--identity` sends the identity twice.

## Limits

- One run per check; the Claude 429 cause is inferred from which requests pass.
- Streaming (`streamText`) on Codex was not checked for the empty-output case; Effect builds the streamed reply from the item events.
- Not tested: the compiled binary, Linux, Sign in with ChatGPT.
