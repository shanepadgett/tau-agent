---
description: Find and investigate a Tau cache debug report
argument-hint: "[incident description]"
---

Find the Tau cache debug report that matches this description:

```text
${ARGUMENTS:-most recent cache debug}
```

Reports are stored in `~/.pi/agent/cache-diagnostics/reports/`. Inspect lightweight top-level metadata from the newest candidates first. Match the description against creation time, originating working directory, session, model, miss count, and recorded markers. Do not ask the user for a path.

Before reading the full report or investigating code, show the selected report's path, creation time, working directory, session identifier, models, and miss count. Ask the user to confirm that it is the intended report. If several candidates match, show the smallest useful set and ask which one they mean.

After confirmation, read the selected report and classify each incident as one of:

- expected local invalidation;
- unexplained local payload change;
- stable payload with an unexplained provider cache miss; or
- inconclusive because correlation or evidence is insufficient.

Use fingerprint differences and lifecycle markers to narrow the cause before inspecting repository code. Inspect only extensions implicated by the changed request category. Do not read the source session or prompt content unless the report is insufficient and the user explicitly approves it.
