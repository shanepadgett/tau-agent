# Web

The web extension adds two tools, reachable only through code mode:

- `webfetch` retrieves a known HTTP(S) URL as Markdown, text, raw HTML, or an inline image.
- `websearch` researches public pages and current external information using the active provider's hosted search, with Exa fallback.

Both register with `codemode` exposure, so scripts call `tools.webfetch` and `tools.websearch` and only the script's output reaches the model. Raw result sets and pages stay in the script.

Call `tools.webfetch({ url: "https://example.com", format: "markdown", timeout: 30 })` to read a page. Markdown conversion preserves code blocks and tables and resolves relative links and images against the final page URL, respecting HTML base URLs. Results record both requested and final URLs in tool details. Text output exceeding the inline limit includes a session-scoped file path containing the complete converted output. Responses are limited to 5 MB; PDFs and other binary downloads return an unsupported-content error instead of unreadable text.

`websearch` uses your existing OpenAI Codex, Anthropic, or Grok login. OpenCode Go and other providers use Exa. If hosted search is unavailable or fails, the tool falls back to Exa without trying another provider's login. Cancelling a search stops it without fallback.

Call `tools.websearch({ query: "...", maxSources: 8, contextMaxCharacters: 10000, timeout: 25 })` in code mode. Only `query` is required. `maxSources` limits returned sources to 1–12; it does not control how many searches the provider performs. `contextMaxCharacters` requests a research text budget of 500–30000 characters; providers may return more or less. `timeout` covers search and fallback together, up to 600 seconds.

Results contain research text and source links. Large output includes a temporary-file path available for the session. Hosted results are synthesized research, while Exa returns retrieved material; use `webfetch` to inspect a source page.

Exa can use an optional `EXA_API_KEY`; no key is required for the default hosted MCP endpoint. The key does not apply to `webfetch`. Hosted search runs through your provider account; availability and charges depend on your plan.

The extension permits outbound HTTP(S) requests. It has no domain allowlist.
