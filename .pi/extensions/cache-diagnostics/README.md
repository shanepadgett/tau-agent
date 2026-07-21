# Cache diagnostics

Cache diagnostics records compact fingerprints of Pi's final provider requests. It exists to separate local prompt changes from provider-side cache failures without storing prompts, source code, or credentials.

The extension runs automatically. Logs are written to:

```text
~/.pi/agent/cache-diagnostics/<session-id>.jsonl
```

Each log keeps request structure, prefix comparisons, response identifiers, and cache usage. Files older than 30 days are removed when a session starts.
