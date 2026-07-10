---
description: Execute an approved simple or full implementation plan
argument-hint: "[slug-or-artifact-path]"
---

Implement: $ARGUMENTS

Resolve the slug or artifact path from the invocation or conversation. Ask one practical question when ambiguous.

Require either:

- One `docs/plans/<slug>.plan.md`; or
- Both `docs/plans/<slug>.spec.md` and `docs/plans/<slug>.technical.md`.

This invocation authorizes execution of the identified artifacts. Read them in full. For a full plan, read the spec before the technical plan.

Stop on conflicting artifacts, unresolved decisions, or code evidence that invalidates the planned design. Do not invent public behavior or silently redesign. State the conflict and ask for a decision.

Implement only the planned scope. Follow the technical plan's boundaries and order. Read additional code only when a named owner, direct dependency, or contradiction requires it.

Choose the lowest-token accurate mutation path. Use the available patch tool for hand-authored changes. Use standard-library scripts, native tools, or shell commands for mechanical bulk changes when clearer and safer. Inspect generated or scripted results before further hand edits.

Remove replaced code, stale references, unused exports, and obsolete resources in the same change. Preserve validation, data safety, security, accessibility, explicit requirements, and hardware calibration.

After implementation, report only non-obvious caveats. Do not restate the plan.
