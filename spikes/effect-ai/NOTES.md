# Effect AI

**Question:** can Effect's AI provider packages (`@effect/ai-anthropic`, `@effect/ai-openai`, `@effect/ai-openai-compat` 4.0.3) carry Tau's subscription routes, and can their streams be recorded and replayed in tests?

**Answer: yes.** Every case passed against the live services and offline, and the offline cases also pass from a compiled binary. Bun 1.4.3, effect 4.0.3, macOS arm64, 2026-10-12.

## What was tried

`main.ts live` reads tokens from `~/.pi/agent/auth.json` and calls each provider through a local recording proxy (`server.ts`). The proxy never stores headers, and a recording is refused if any token appears in it. `main.ts replay` serves the recordings from `Bun.serve` on port 0 and compares each decoded turn with the live one. Each first turn asks the model to reason, then call one `Tool.dynamic` tool named `run` (JSON Schema parameters), with `disableToolCallResolution: true`. Each turn is replayed with a tool result to the same and other routes.

| # | Case | Result |
| --- | --- | --- |
| 1 | Claude subscription, `claude-sonnet-5-5` | Pass. No API key; `transformClient` sets `Authorization: Bearer`, appends `claude-code-20250219,oauth-2025-04-20` to the betas Effect already set, and the Claude Code identity is the first system message. Thinking, text and a tool call decode. |
| 2 | ChatGPT Codex, `gpt-6-luna` | Pass. `apiUrl` `…/backend-api/codex`; headers `chatgpt-account-id`, `originator`, `OpenAI-Beta`, `session-id`; config `store: false`, `instructions`, `include: ["reasoning.encrypted_content"]`, `service_tier: "priority"`, `prompt_cache_key`. Reasoning summary and a tool call decode. |
| 3 | Replay across models | Pass. `Prompt.fromResponseParts` keeps Claude's thinking signature; Sonnet and Opus both accept it. Codex reasoning goes back as reasoning items with encrypted content and IDs, and Codex accepts them. Each package ignores the other providers' options, so cross-provider replay drops native data with no Tau code. |
| 4 | OpenRouter, `anthropic/claude-haiku-5.5` | Pass. The extra `reasoning` field passes through; reasoning, text and a tool call decode. |
| 5 | Recorded replay | Pass. All three recordings decode offline to the same parts as the live run (types, text, reasoning, tool calls, finish reason, usage). |
| 6 | Token read per request | Pass. One built layer sends `token-1`, then `token-2` after the `Ref` changes, through `HttpClient.mapRequestEffect`. |
| 7 | Compiled binary | Pass. `bun build --compile --minify` gives 71 MB; cases 5 and 6 pass from it. |

### Cases 8–13 (`more.ts`)

`more.ts live` adds an OpenAI API key from the same auth file. `more.ts replay` replays its recordings.

| # | Case | Result |
| --- | --- | --- |
| 8 | Jev through OpenRouter | Pass through Tau's own adapter. `@effect/ai-openrouter`'s `OpenRouterDecisionModel` posts to `/alpha/decisions`, which returns 404. A ~50-line `DecisionModel.make` adapter over System One (`POST /api/v1/systemone`: `state`, `questions` typed `choice`/`score`/`noul`) answers classify, probability and rate questions for `~typesafe/jev-latest`, and for `openai/gpt-6-luna-decisions` on the same endpoint. |
| 9 | Luna through OpenAI Decisions | Pass through Tau's own adapter: `POST /v1/decisions` with the state as JSON text and `choice`/`score`/`predicate` questions. Score probabilities arrive as `{ value: index, label, probability }`, so map them by `label`. A ChatGPT subscription token is refused with "A valid API key is required." |
| 10 | OpenAI API-key route, `gpt-6-luna` | Pass. `@effect/ai-openai` with `apiKey`; reasoning, a tool call, and a replay with encrypted reasoning. |
| 11 | `generateObject` on every chat route | Pass on all five routes, two after fixes. Claude subscription uses `output_config.format`; OpenAI uses `text.format`; both OpenRouter packages use `response_format`. **Codex** rejects non-streaming requests ("Stream must be set to true"), and it adds a `phase: "commentary"` message before the final answer. A `transformClient` shim turns the request into a stream, keeps the `response.completed` body, and drops commentary messages. **`@effect/ai-openrouter`** sends `strict: null` unless `strictJsonSchema: true`. Without strict, OpenRouter routed to Azure, whose Claude ignored the schema and answered in prose, even with `provider.require_parameters: true`. Strict fixed it. |
| 12 | `@effect/ai-openrouter` chat model | Pass. Unlike the generic Chat Completions package, it replays `reasoning_details` with Claude's signatures. |
| 13 | Recorded replay | Pass. All ten recordings from cases 8–12 decode offline to the live results, under `bun` and from a compiled binary. |

Prompt caching was also checked. Claude reads 12,762 of 12,849 input tokens from the cache on a repeat call, with `cacheControl` in the system message's `anthropic` options. Codex reads 7,680 of 8,514, but only once the `session-id` header is sent alongside `prompt_cache_key`.

## Findings that shape the build

- **Claude thinking text needs `thinking.display: "summarized"`.** Without it, thinking arrives with a signature but no text. Effect's generated types lack `display`, but the field passes through at runtime. It is the only config field these routes needed that the types lack.
- **Codex reports `service_tier: "default"` even when priority was requested.** Pi treats a priority request as priority, and so should Tau's usage and cost reporting.
- **Effect never puts `cache_control` on assistant content blocks** (a TODO in `AnthropicLanguageModel`). Breakpoints work on system, user and tool-result parts.
- **The generic Chat Completions package drops OpenRouter's `reasoning_details` on replay.** It replays reasoning text only, so Claude signatures are lost; OpenRouter still accepts the turn. `@effect/ai-openrouter` keeps them (case 12).
- **Decision models need Tau's own adapters.** Effect's `DecisionModel` interface and answer validation fit both wire APIs, but neither provider package reaches a working endpoint.
- **Codex marks commentary.** Message items carry `phase: "commentary"` or `"final_answer"`. Effect ignores the field, so the TUI cannot tell them apart without reading it from the raw item.
- **Codex responses carry a per-account `safety_identifier`.** Recordings replace it with `user-redacted`.

## Limits

One model per route. Error paths (rate limits, expired tokens, HTTP 5xx), login flows, long sessions, Codex's WebSocket transport, OpenCode Go and Linux were not tested. The recordings hold encrypted reasoning and signatures, but no credentials or account IDs.

Run: `bun install`, then `bun main.ts replay` and `bun more.ts replay` (offline), or the `live` modes (a few cents; they need Pi's auth file).
