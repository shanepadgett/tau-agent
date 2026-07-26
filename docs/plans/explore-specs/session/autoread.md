# Autoread

## Purpose

- Establish file knowledge in active context for selected paths without the agent manually calling `read`, when the harness/extension injects autoread messages.
- Feed complete-file trust/cache machinery used by later `read` unchanged/diff behavior when a full body was injected.

## Behavior

- Autoread loads file bytes under size limits.
- Thresholds from [settings.md](../cross/settings.md) / [read-policy.md](../cross/read-policy.md) (`structureThresholdLines`).
- **Supported source, line count ≤ threshold:** inject full file text and register complete-file knowledge while that source remains in active context ([read.md](../fs/read.md) unchanged/diff chain).
- **Supported source, line count > threshold:** inject **outline only** for that file (same shape as large full `read` / [outline.md](../shape/outline.md)). Do not inject full body. Do not auto-run [context.md](../graph/context.md).
- **Markdown / unsupported text:** full file within size limits (Markdown ungated per read-policy).
- Injected agent text follows [output-density.md](../cross/output-density.md).
- Outline-only autoread does not create a complete-file body baseline.
- Lifecycle invalidation follows [system.md](../cross/system.md) (compact/tree/shutdown).
- If lifecycle is no longer current mid-flight, autoread must not commit stale knowledge.
- Failures are represented as autoread status/error details rather than silently inventing contents.

## Non-goals

- Not a general always-on full-repo ingest
- Not a silent full dump of large supported source
- Not automatic `context` packing
