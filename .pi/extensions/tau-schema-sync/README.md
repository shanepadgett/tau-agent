# tau-schema-sync

Local dev extension for Tau settings schema drift.

It also injects coding guidance that Tau extension settings must live in `src/extensions/<extension>/settings.ts`, next to that extension's `index.ts`, and that `schemas/tau.schema.json` should not be manually edited.

After each tool result, it detects added, modified, or deleted `src/extensions/**/settings.ts` files and runs:

```text
node --experimental-strip-types scripts/generate-tau-schema.ts --write
```

This means schema sync runs after the edit tool result, not during the edit tool call. If an agent edits a settings file and reads `schemas/tau.schema.json` in the same parallel tool batch, it can race schema sync. A later tool call is safe.

Agents should not write `settings.ts` and read `schemas/tau.schema.json` in the same parallel tool batch. Write settings first, then read schema only in a later tool call.

Still keep `mise run check` as enforcement. This is only convenience while coding in Pi.
