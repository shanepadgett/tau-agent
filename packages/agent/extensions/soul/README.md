# Soul

Soul shapes how Tau works and talks by adding two independent sections to Pi's native assistant prompt:

- **ponytail** — a lazy-senior-dev build ethos: do the smallest correct thing, reuse before writing, YAGNI, fix bugs at the root, never cut validation, security, or accessibility.
- **simplified** — Simplified Technical English (ASD-STE100): use short sentences and paragraphs, explain jargon, and shape plans and conversations in small chunks.

Pi continues to own tool guidance, project instructions, skills, documentation paths, custom prompts, and working-directory context.

Toggle each section in Tau settings (both on by default):

```json
{
  "extensions": {
    "soul": { "ponytail": true, "simplified": false }
  }
}
```

Settings take effect on session start.

After changing this extension, run `/reload` before testing the new behavior.
