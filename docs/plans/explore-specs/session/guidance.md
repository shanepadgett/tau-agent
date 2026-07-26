# Pre-turn exploration guidance

## Purpose

- When a workspace looks like it contains supported source and the worker can serve those languages, inject short exploration policy into the agent system prompt before the turn.

## When guidance is added

- Before agent start, scan a bounded ignore-aware slice of the working root (discovery budget, currently 4096 entries; ignore rules per [path-conventions.md](../cross/path-conventions.md)).
- Detect supported language files by extension.
- Intersect detected languages with worker-advertised languages ([system.md](../cross/system.md)).
- If the intersection is non-empty, append Explore source policy text to the system prompt.
- If scan fails, worker fails, or no supported languages overlap → add nothing (ordinary filesystem workflow).

## Guidance content requirements

- State which languages are structurally backed in this workspace (from worker advertisement).
- Same tool workflow for every backed language; do not invent per-language choreography.
- Instruct smallest sufficient query; stop early.
- Identify job type before deep loading.
- Prefer [outline.md](../shape/outline.md) for unfamiliar trees and known packages; large full `read` returns outline per [read-policy.md](../cross/read-policy.md).
- Use ranged [read.md](../fs/read.md) (max range lines) or [show.md](../shape/show.md) for bodies.
- Prefer [discover.md](../shape/discover.md) for reuse when path is unknown; prefer package/public surfaces first.
- Target binding is path+name(+line) only ([identity.md](../cross/identity.md)) — no session locators ([stripped.md](../stripped.md)).
- `show` views cheapest → richest: signature → signatureWithDocs → declaration → declarationWithImports.
- Run [impact.md](../graph/impact.md) before non-trivial symbol changes.
- Use [context.md](../graph/context.md) to understand one symbol in one pack.
- Use [relationships.md](../graph/relationships.md) after selecting a change target.
- [ast-search.md](../shape/ast-search.md) for shapes; [grep.md](../fs/grep.md) for literals; `read` for formatting/comments/gaps/unsupported.
- Edit with harness patch/edit/write only.
- Trust tool hits as path/line/exact text — not scores or engine meta ([output-density.md](../cross/output-density.md)).

## Non-goals

- Guidance is advisory prompt text. Enforcement for large dumps is [read-policy.md](../cross/read-policy.md), not this text.
- Does not disable tools.
- Must not teach stripped unlock/locator choreography ([stripped.md](../stripped.md)).
