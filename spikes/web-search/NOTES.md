# Web search

**Question:** do the provider-side web search tools work through Tau's own routes on each provider's small model, and does Exa's hosted MCP endpoint answer without a key?

**Answer: hosted search works on all four routes; Exa without a key is rate limited.** Bun 1.4.3, macOS arm64, 2026-10-15, one query per route.

## Setup

`check.ts` builds Tau's `Models` from `~/.tau`, takes `smallModel` of each route, and calls `generateText` with `AnthropicTool.WebSearch_20250305({ maxUses: 3 })` or `OpenAiTool.WebSearch({})` and `toolChoice: "required"`. It saves every raw reply in `recordings/`. Run `bun check.ts`, or `bun check.ts codex` for one route.

## Results

| Route | Small model | Time | Parts | Sources |
| --- | --- | --- | --- | --- |
| `anthropic` (Claude subscription) | `claude-haiku-5-5` | 4.3 s | tool call, tool result, source, reasoning, text | `source` parts with titles; tool result holds every result with URL and title |
| `codex` | `gpt-6-luna` | 6.1 s | tool call, tool result, text | no `source` parts; tool result's `action.sources` holds URLs only |
| `chatgpt` | `gpt-6-luna` | 7.2 s | tool call, tool result, text, source | one `source` part from a URL citation; `action.sources` too |
| `openai` (API key) | `gpt-6-luna` | 8.5 s | tool call, tool result, text | as `codex` |
| Exa, no key | — | 0.3 s | — | HTTP 200 with `_meta["ai.exa/rateLimited"]: true` and a text asking for a key |

- Effect adds `include: web_search_call.action.sources` by itself on the OpenAI routes; the Codex stream collector needed no change.
- The answer text carries inline Markdown links on every route, so the model reading it has links even when `source` parts are missing.
- A rate-limited Exa reply looks like a success: status 200 and a text result. Only `_meta` tells them apart.

## Limits

One query per route. OpenCode Go and OpenRouter were not tried (they search with Exa). Exa with a key was not tried. Compiled binary untested.
