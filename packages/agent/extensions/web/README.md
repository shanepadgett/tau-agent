# Web

The web extension adds two tools, reachable only through code mode:

- `webfetch` retrieves a known HTTP(S) URL as Markdown, text, raw HTML, or an inline image.
- `websearch` discovers public pages and current external information through Exa.

Both register with `codemode` exposure, so scripts call `tools.webfetch` and `tools.websearch` and only the script's output reaches the model. Raw result sets and pages stay in the script.

`websearch` can use an optional `EXA_API_KEY`. The key does not apply to `webfetch`.

The extension permits outbound HTTP(S) requests. It has no domain allowlist.
