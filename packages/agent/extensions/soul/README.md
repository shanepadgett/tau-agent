# Soul

Soul shapes how Tau works and talks by adding two independent sections to Pi's native assistant prompt:

- **ponytail** — a lazy-senior-dev build ethos: do the smallest correct thing, reuse before writing, YAGNI, fix bugs at the root, never cut validation, security, or accessibility.
- **caveman** — a terse communication style: drop filler, keep technical substance exact, quote the shortest decisive line, spell out anything where brevity would risk safety.

Pi continues to own tool guidance, project instructions, skills, documentation paths, custom prompts, and working-directory context.

Toggle each section in Tau settings (both on by default):

```json
{
  "extensions": {
    "soul": { "ponytail": true, "caveman": false }
  }
}
```

Settings take effect on session start.

After changing this extension, run `/reload` before testing the new behavior.
