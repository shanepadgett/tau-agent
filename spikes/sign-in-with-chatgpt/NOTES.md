# Sign in with ChatGPT

**Question:** can Tau use OpenAI's Sign in with ChatGPT (open-source plan usage) as a subscription login, with requests built by Effect's OpenAI package against the public Responses API? The answer decides whether it joins or replaces the Codex login.

**Run:** `bun login.ts` registers Tau (first run) or signs in again with the issued client ID, and saves tokens, the client ID and a `urn:uuid:` host ID in `state/` (gitignored). `bun check.ts [model]` lists models, makes four kinds of calls through `@effect/ai-openai` 4.0.3, refreshes once, and writes `results.json` (gitignored). `bun check.ts decision` tries Luna decisions with the token. `bun ./import.ts` copies the registration and host ID into `~/.tau`, so `tau login` reuses this registration.

Docs: <https://developers.openai.com/siwc/token-sharing-open-source> and its sign-in, accounts-and-sessions, models-and-inference, token-reference and preview-limitations pages.

## Results (2026-10-12, macOS arm64, under `bun`)

| Check | Result |
| --- | --- |
| First login | Pass. `client_id=dynamic_agent_client`, `agent_name_hint=Tau`, `ext_agent_host_id`, `resource`, `nonce`. Callback on `127.0.0.1:1455/auth/callback` returned `code`, `state`, `scope` and an issued `oaiapp_…` client ID. Token exchange at `/api/accounts/oauth/token` with the issued ID and `resource`. Granted scopes include `chatgpt.tokens.use.direct`. |
| Token response | `access_token` (one hour), `refresh_token`, `id_token`, `scope`, `token_type`, `expires_in`, and `earliest_refresh_at`: a Unix time 54 minutes after issue. A refresh two minutes after issue still succeeded, so it reads as a hint for when to refresh. |
| Refresh | Pass. Form POST with the issued client ID and `resource`; the refresh token rotates. |
| Model list (`GET /v1/models`) | `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`. |
| `generateText` as Effect sends it | **400 `Stream must be set to true`.** Effect sends non-streaming requests without `stream`. |
| `generateText` through Tau's stream collector (`src/ai/codex.ts`) | Pass. |
| `streamText` with a system message | Pass. Effect sends it as a `developer` message for reasoning models. |
| `streamText` with a function tool | Pass. Effect's top-level `type: "function"` tool was accepted, though the docs ask for namespaces. |
| `generateObject` through the collector | Pass. |
| Luna on the Decisions API (`bun check.ts decision`) | **Refused:** 401 `rejected_by_access_enforcement`, `no_matching_rule`. Decisions need an API key, as with Codex tokens. |

Every request carried `store: false` and none of the fields the preview forbids; Effect sent `model`, `store`, `include`, `input`, `text`, and for tools `tools` and `tool_choice`.

## Limits

- Not checked: ID-token signature verification against OpenAI's keys, token revocation on logout, a second sign-in with the saved client ID and `id_token_hint`, usage-limit errors, images, and the compiled binary.
- The browser showed "This site can't be reached" on the first login because `login.ts` stopped its listener before the browser received the page; the tokens were saved. Fixed in the spike. Tau's `src/ai/login.ts` stops its listener only after the token exchange.
