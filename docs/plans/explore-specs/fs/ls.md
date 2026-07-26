# `ls`

## Purpose

- Same job as stock Pi `ls`: list files/directories under roots.
- Explore value: **denser agent text** via path-tree factoring ([output-density.md](../cross/output-density.md)), ignore/noise defaults, hard caps.

## Parameters

Stay Pi-compatible enough for transfer learning:

- `paths` (optional string[]) — roots; default cwd/default root when omitted
- `depth` (optional number) — default `1`
- `limit` (optional number) — max entries; default `100`
- `all` (optional boolean) — include hidden, ignored, and noise paths
- `long` (optional boolean) — size/mtime metadata on entries (off by default; off keeps agent text lean)

## Behavior

- Resolve paths under cwd rules ([path-conventions.md](../cross/path-conventions.md)).
- Traverse with ignore/hidden/noise defaults unless `all`.
- Include the root entry.
- Split `limit` across roots.
- **Agent output:** path tree — shared directory spine, indented names, no full-path spam per row ([output-density.md](../cross/output-density.md)).
- Omission notice when `limit` cuts entries (count only).
- Large listings still pass [bounded-output.md](../cross/bounded-output.md).
- No search meta, no timing, no “listed N files” success banners beyond omission needs.

## Errors / edge cases

- Bad path → clear error
- Cancellation honored
- Empty dirs representable

## Non-goals

- Not a whole-repo dump without depth/limit
- Not richer than Pi unless density/defaults require it
