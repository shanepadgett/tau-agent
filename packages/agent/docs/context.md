# Context management

Tau uses `.pi/contexts` as a reusable map of the repository. A selected context supplies a small bootstrap projection for a work scope and points toward related files without loading everything.

## Structure

The catalog has three levels:

```text
.pi/contexts/<domain>/<concept>.toml
                         └── [entry]
```

- **Domain**: a stable top-level area of the repository, such as `commerce`, `platform`, or `documentation`. Domains become tabs in `/context`.
- **Concept**: a coherent subsystem or capability inside a domain. Each concept is one TOML file.
- **Entry**: a selectable work scope inside that concept. Each TOML section defines one entry.

Domain folders, concept filenames, and entry section names use lowercase kebab-case.

```toml
name = "Checkout"
description = "Checkout calculation and order submission"

[orchestration]
description = "Building and submitting a checkout order"
read = []
outline = ["src/checkout/order.ts", "src/checkout/service.ts"]
references = ["test/checkout/service.test.ts", "src/payments/client.ts"]

[discounts]
description = "Applying coupons and account discounts"
read = []
outline = ["src/checkout/discounts.ts"]
references = ["test/checkout/discounts.test.ts"]
```

Saved as `.pi/contexts/commerce/checkout.toml`, these entries have the IDs `commerce/checkout/orchestration` and `commerce/checkout/discounts`.

## Build a useful taxonomy

A good entry gives the agent enough primary code to start one recurring kind of work without flooding its context window. Classify each scope from the top down:

1. **Domain:** Which stable product or technical area owns this work?
2. **Concept:** Which subsystem inside that area has a clear shared purpose?
3. **Entry:** Which files are commonly needed together for one task?

Reuse existing terms when they still describe the code honestly. Create, move, split, or merge taxonomy when ownership or subsystem boundaries change. Directory layout can inform the decision, though domains and concepts should describe responsibility rather than copy the source tree.

Keep entries focused. Names such as `misc`, `shared`, and `other` hide missing boundaries. A broad `all` entry can support deliberate subsystem-wide work, but focused entries should remain available for normal tasks. If an entry keeps collecting unrelated paths, split it by work scope. If several tiny entries are always selected together, merge them.

Catalog durable code, configuration, tests, standards, and long-lived documentation. Leave scratch files, working plans, interviews, generated output, and rough ideas out of the catalog.

## Choose loading modes

- `read` supplies exact complete file contents. Reserve it for instructions, small authoritative specifications, and other files whose exact wording is routinely needed.
- `outline` supplies current structural outlines through Explore. Use it for recurring source entry points.
- `references` supplies unloaded navigation paths. This should be the default for durable code, tests, callers, shared dependencies, and secondary documentation.

Every entry declares all three arrays, including empty arrays. Keep `read` and `outline` small because Tau rebuilds them before model calls. Keep each path's loading mode consistent across the catalog. When selected entries disagree, precedence is `read`, then `outline`, then `references`.

`/context` persists selected entry IDs as branch-local session state. It does not append file contents to conversation history. Before each model call Tau resolves those IDs against the current catalog, reads current `read` files, refreshes changed outlines, and adds one ephemeral projection. Reopening `/context` replaces the active selection. Clear all selections and confirm to remove the projection.

## Maintain the map

Inspect the existing catalog before placing new paths. Re-evaluate domain, concept, and entry boundaries after moves, ownership changes, or a coherent batch of new work; avoid stuffing paths into the nearest existing bucket.

Run `/context-sync` to update the catalog from uncommitted repository changes. Tau can also delegate to the `context-sync` subagent when automation is enabled. Context sync checks every eligible changed file for membership, removes stale paths, and re-evaluates the taxonomy before editing `.pi/contexts`.
