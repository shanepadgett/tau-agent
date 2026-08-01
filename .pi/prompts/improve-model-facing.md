---
description: Tighten model-facing strings in one extension
argument-hint: "[extension-path] [focus]"
---

Improve the model-facing instruction surface.

Args: `${ARGUMENTS:-}`

- Optional extension path (first path-like token).
- Optional focus after that (tool name, `description`, `guidelines`, `snippet`, `params`, `errors`, etc.).

## Goal

Same job as `/audit-model-facing`, but redesign the text. Agent should see each fact **once**, in the **right channel**, with no brochure padding. Token-cheap. Behavior unchanged.

**Hard gate: propose only.** Do not edit files, apply patches, or "go ahead and update" the extension. Output the proposal and stop. Implementation happens only in a later turn if the user explicitly approves.

## Ingest

Two entry modes. Pick one; do not do both blindly.

### A. Thread already has the surface

This prompt often runs **in the same chat** right after `/audit-model-facing` (or a manual audit / redesign thread).

- Prefer conversation context: prior “As the agent sees it” blocks, diagnoses, user nits, chosen variants (node-only vs all runtimes).
- Resolve the target extension from that thread if no path arg.
- Do **not** re-scan the tree or re-quote the full before-state unless the thread is missing pieces, stale vs the files, or the user is steering a different extension than the one just audited.
- Treat user feedback in-thread as constraints on the proposal.

### B. Path arg / cold start

If a path arg is present and the thread does **not** already hold a usable audit of that same extension — new chat, different extension than the thread’s focus, or no prior catalog:

1. Run the `/audit-model-facing` inventory for that path first (same method and expanded “as the agent sees it” before-state).
2. Then diagnose and propose improvements **in the same turn**.
3. Keep the before catalog short enough to work from; the main deliverable is still the after proposal, not a second full audit essay.

If path arg is missing and the thread does not name an extension, ask once.

## Channel jobs

| Channel | Job |
| --- | --- |
| `promptSnippet` | Discoverability one-liner only |
| `description` | Call contract: what, how, protocol, availability |
| `promptGuidelines` | Standing habits **not** already in description |
| Parameter schema | Field role only |
| Success results | Outcome shape only |
| Errors | What failed + how to continue (id/shape) — no usage sermon |
| System prompt / injects | Only what must be always-on or event-scoped; no tool-doc dump |

**One home per fact.** Delete restates. Move, don’t duplicate.

**Cut obvious** coding-agent literacy (APIs exist, JS runs, etc.). Keep non-obvious mechanics (flags, not-tsc, permissions, eviction, retry shape).

**Compress.** Short sentences/fragments. Exact terms, flags, shapes.

## Diagnose (short)

Before proposing, bullets only:

- dupes (fact → channels that repeat it)
- wrong channel
- obvious padding
- missing non-obvious constraint
- droppable snippet (if description already carries discovery)

Skip empty categories.

## Propose

Emit **only** the after state, same shape as audit “As the agent sees it” (` ```text ` blocks per channel). No code. No full before dump.

Then a tight **Moves** list: `fact → home` and what died. Five to twelve bullets max.

If focus arg set, only that slice; still keep one-home vs the rest of the surface (don’t shove cut text into an untouched channel).

## Stop

End after Diagnose + Propose + Moves. No file writes in this invocation. If the user later approves, they will say so in a new message — do not treat silence, "looks good," or partial nits as apply permission unless they clearly order the edit.
