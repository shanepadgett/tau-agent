# Cache Diagnostics

Cache Diagnostics records compact fingerprints of Tau's final provider requests. It helps separate local prompt changes from unexplained provider cache misses without storing prompts, source code, or credentials.

The extension runs automatically. Logs are written under:

```text
~/.pi/agent/cache-diagnostics/
```

Run `/cache-debug` after suspicious misses. Tau writes a bounded report under `~/.pi/agent/cache-diagnostics/reports/` for later investigation. Logs and reports older than 30 days are removed when a session starts.
