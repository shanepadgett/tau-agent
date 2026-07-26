# `ls`

## Purpose

- List files and directories under one or more roots with compact path output.

## Parameters

- `paths` (optional string[]) — roots to list; default behavior covers cwd/default root when omitted per implementation defaults
- `depth` (optional number) — traversal depth; default `1`
- `limit` (optional number) — max entries across the call budget; default `100`
- `all` (optional boolean) — when true, include hidden, ignored, and noise paths
- `long` (optional boolean) — include extra metadata in listing presentation

## Behavior

- Resolve each path under cwd rules.
- Traverse with ignore/hidden/noise defaults unless `all`.
- Include the root entry in the listing.
- Split the total `limit` across requested roots.
- Render as a path tree suitable for humans and agents (agent text may differ slightly from human text if dual rendering is used).
- If entries are omitted due to limit, say how many were omitted for that budget.

## Errors / edge cases

- Invalid path resolution → clear error
- Cancellation honored
- Empty directories still representable (including empty markers when traversal finds no visible children within depth)

## Non-goals

- Not a recursive whole-repo inventory without depth/limit
- Does not unlock read gate
- Does not issue structural locators
