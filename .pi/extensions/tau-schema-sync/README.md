# tau-schema-sync

Local development extension for Tau settings schema drift.

After each tool result, it detects added, modified, or deleted `packages/agent/extensions/**/settings.ts` files and runs:

```text
node --experimental-strip-types packages/agent/scripts/generate-tau-schema.ts --write
```

Schema sync runs after the edit tool result. If an agent edits a settings file and reads `packages/agent/schemas/tau.schema.json` in the same parallel tool batch, the read can race schema sync. A later tool call is safe.

Repository guidance in `AGENTS.md` defines settings placement and generated-schema rules. The normal project checks remain enforcement; this extension is coding convenience.
