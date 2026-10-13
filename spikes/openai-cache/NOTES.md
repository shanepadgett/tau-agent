# OpenAI prompt cache

**Question:** why do the `chatgpt` and `codex` routes read nothing from the prompt cache, and which request change fixes it?

**Tried:** `check.ts` runs Tau's own `Models` with the saved logins. Each conversation sends a system prompt of about 3,000 tokens, then three or four one-word turns. Each turn repeats the earlier requests and adds the new user message. A fetch wrapper adds header variants, compares each request body with the one before it, and reads `input_tokens_details` from the raw reply. Cases: `codex` and `chatgpt` routes × `gpt-6-luna` and `gpt-6.1-sol` × header variants. `bun check.ts` runs four variants once each; `bun check.ts repeat` runs the body key alone and `session-id`, three conversations each, with a unique first line per conversation so that no conversation reads another's cache.

## Result

The missing `session-id` header is the cause. Tau's requests do not change between turns: every request repeats the one before it byte for byte, with the same top-level fields.

| Requests carry | Later turns that read the cache (repeat run) |
| --- | --- |
| `prompt_cache_key` only (Tau before the fix) | 2 of 36 |
| `prompt_cache_key` and `session-id` | 28 of 36 |
| Tau after the fix (it adds `session-id` itself) | 28 of 36 |

Per case in the run with the fix: `codex` Luna 7 of 9, `codex` Sol 6 of 9, `chatgpt` Luna 7 of 9, `chatgpt` Sol 8 of 9. A hit reads 2,816 tokens on Luna and 3,584 to 3,712 on Sol, of about 3,800.

Other findings:

- `session_id` and `session-id` with `x-client-request-id` also work in the single run, but less often on Luna. Codex CLI and Pi send `session-id`, so Tau does too.
- `cache_write_tokens` is 0 on every reply on both routes, also before a read. These routes do not report cache writes, so `cacheWriteTokens` stays 0 on them.
- The first turn of a conversation never reads, as expected. About one later turn in five misses with no visible cause; the turns were sent seconds apart.
- `gpt-6.1-sol` caches on the `codex` route with `session-id`. Codex issue #51353 reports no reads there, but that report does not mention the header.

## Limits

macOS arm64, 13 October 2026, one account. The `openai` API-key route also gets the header but was not tested live. Turns were short, so the runs do not show how much of a long conversation is read. No compiled binary.
