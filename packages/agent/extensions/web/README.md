# Web

The web extension adds three low-level tools:

- `webfetch` retrieves a known HTTP(S) URL as Markdown, text, raw HTML, or an inline image.
- `websearch` discovers public pages and current external information through Exa.
- `codesearch` retrieves code examples and implementation-focused documentation context through Exa.

Keeping these jobs separate lets agents fetch a known source without searching, or search for the kind of context the task needs. Agents invoke each tool directly and can combine them in a separate research workflow.

`websearch` and `codesearch` can use an optional `EXA_API_KEY`. The key does not apply to `webfetch`.

The extension permits outbound HTTP(S) requests. It has no domain allowlist.
