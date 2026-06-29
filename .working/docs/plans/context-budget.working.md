# Context Budget Working

## Stub shape

Build Tau extension `context-budget` later, separate from `turn-budget` so each nudge mechanism can be tested independently.

Purpose: soft pressure model to stay in better context-usage zones and compact at good boundaries.

Default settings draft:

- `enabled: true`
- `startPercent: 20`
- `nudgeEveryPercent: 10`

Fixed thresholds for first version:

- under 40%: best intelligence zone; stay compact when easy.
- 50%: first caution.
- 80%: ask agent to find stopping point and have user compact.

Likely files:

- `src/extensions/context-budget/index.ts`
- `src/extensions/context-budget/settings.ts`
- `src/extensions/context-budget/README.md`

Relevant repo/docs facts:

- `ctx.getContextUsage()` returns current active model context usage. Docs: `/Users/spadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` ExtensionContext section.
- Existing footer uses `ctx.getContextUsage()` in `src/extensions/footer/index.ts` around `contextText`.
- `ctx.compact()` exists and can trigger compaction without awaiting completion.

## Behavior draft

- On outbound `context`, read `ctx.getContextUsage()`.
- If percent is unknown, inject nothing.
- Nudge at 20%, 30%, 40%, 50%, 60%, 70%, 80%...
- Do not inject every request inside same bucket.
- Keep hidden context tiny.
- At 50% mention caution and preserving useful context.
- At 80% tell agent to find a clean stopping point, record continuation evidence, and ask user to compact.

## Open decisions

- Should extension call `ctx.compact()` itself? Possible API exists, but that is a public behavior change and may interrupt/reshape session. Hold. Safer first version asks agent to stop and request compaction.
- Whether an LLM-callable compact tool is needed. Probably separate extension/tool if approved; not part of stub.
- Reset bucket tracking on session tree/fork/resume?

## Held for later

- No implementation in this chat unless user switches focus.
- No visible footer/status.
- No automatic pruning.
