# Let the agent search the web

The agent can search the public web and read web pages while it works, with the `web` functions inside `run`.

The agent calls these functions itself. You do not call them, and nothing needs setting up for Claude, ChatGPT, Codex or OpenAI sessions.

1. Ask for something that needs the web, such as `Find the current Bun release notes and list the breaking changes`.
2. The agent searches: `const found = await tools.web.search({ query: "Bun release notes" });`. It returns `text`, a short answer with Markdown links, `sources` (each with `url` and `title`), `route`, the service that searched, and `fellBack` when Tau had to switch to Exa. `maxSources` is 8 by default and at most 12; `timeoutSeconds` is 25 by default.
3. The agent reads a page: `const page = await tools.web.fetch({ url: found.sources[0].url });`. It returns the final `url`, `status`, `contentType` and `text`. `timeoutSeconds` is 30 by default.
4. For an OpenRouter, OpenCode Go or custom provider session, set an Exa API key before you start Tau, so searches are not rate limited:

   ```sh
   export EXA_API_KEY=your-exa-key
   ```

## What happens

Search runs on the small model of the session's provider, with that provider's own search tool:

| Session provider | Searches with |
| --- | --- |
| Anthropic (API key or Claude plan) | Claude web search |
| OpenAI, ChatGPT plan, Codex | OpenAI web search |
| OpenRouter, OpenCode Go, custom providers | Exa |

When the provider's search fails or takes more than 70% of the timeout, Tau searches Exa in the time left and sets `fellBack` to `"failed"` or `"timeout"`. Exa searches from all sessions start at least 2 seconds apart.

`fetch` turns HTML into plain text and puts each link's address after its text. JSON, XML, JavaScript and other text come back as they are.

## Limits

- Without `EXA_API_KEY`, Exa's free tier often refuses searches as rate limited. The search then fails with a message that names `EXA_API_KEY`.
- A provider search costs that provider's search fee on top of the small model's tokens.
- `fetch` refuses pages over 5 MB and binary files, such as images and PDFs.
- `fetch` does not run JavaScript, so a page that builds its content in the browser comes back nearly empty.
