# Autoread

## Purpose

- Establish file knowledge in active context for selected paths without the agent manually calling `read`, when the harness/extension injects autoread messages.
- Large supported source must not silently dump full bodies.

## Behavior

- Autoread loads file bytes under size limits.
- Thresholds from [settings.md](../cross/settings.md) / [read-policy.md](../cross/read-policy.md) (`structureThresholdLines`).
- **`explore.read.enabled` is `false`:** ordinary full inject within size limits for all text paths (no outline substitution).
- **Registered source (incl. Markdown), line count ≤ threshold:** inject full file text.
- **Registered source (incl. Markdown), line count > threshold:** inject **outline only** for that file (same shape as large full `read` / [outline.md](../shape/outline.md); Markdown → headings). Do not inject full body. Do not auto-run [context.md](../graph/context.md).
- **Unregistered text:** full file within size limits.
- Injected agent text follows [output-density.md](../cross/output-density.md).
- Outline-only autoread does not create a complete-file body baseline (no such product cache — [stripped.md](../stripped.md)).
- Lifecycle invalidation follows [system.md](../cross/system.md) (compact/tree/shutdown) for any session knowledge the implementation tracks.
- If lifecycle is no longer current mid-flight, autoread must not commit stale knowledge.
- Failures are represented as autoread status/error details rather than silently inventing contents.

## Non-goals

- Not a general always-on full-repo ingest
- Not a silent full dump of large supported source
- Not automatic `context` packing
- Not an unchanged/diff read cache feeder
