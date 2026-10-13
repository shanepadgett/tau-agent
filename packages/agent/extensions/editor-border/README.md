# Editor Border Extension

Embeds extension-provided text in five slots across the editor's top and bottom borders:

```text
── work order 4521 ─────────────── [••••·--?---!-|------] ──────────────────────────
 > type here
── reviewing bash ────────────────────────────────────────────────────────────────────
```

The footer extension places the context bar in the top-center slot. Other extensions can publish to the top-left, top-right, bottom-left, and bottom-right slots. The session name appears in the footer, not the editor border. Working, compaction, and retry indicators stay in Pi's status area above the editor.

Other extensions publish with the `tau:editor-slot` event; see the Tau Agent extension docs.
