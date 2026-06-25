# tau-schema-sync

Local dev extension for Tau settings schema drift.

It also injects coding guidance that Tau extension settings must live in `src/extensions/<extension>/settings.ts`, next to that extension's `index.ts`, and that `schemas/tau.schema.json` should be generated instead of manually edited.

After each agent turn, it detects changes to `src/extensions/**/settings.ts`, runs:

```text
node --experimental-strip-types scripts/generate-tau-schema.ts --write
```

Then it reports success or failure at agent end.

Still keep `mise run check` as enforcement. This is only convenience while coding in Pi.
