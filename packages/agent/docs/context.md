# Context management

Tau uses `.pi/contexts` as a reusable map of the repository. Selecting a context injects a small bootstrap for a work scope and points toward related files without loading everything.

## Structure

The catalog has three levels:

```text
.pi/contexts/<NN_domain>/<concept>.toml
                            └── [entry]
```

- **Domain**: a stable top-level area of the repository, such as `commerce`, `platform`, or `documentation`. Domain folders are named `NN_slug` with a two-digit order (`01_extensions`, `02_core`, …). `/context` sorts tabs by that prefix and shows the slug only.
- **Concept**: a coherent subsystem or capability inside a domain. Each concept is one TOML file.
- **Entry**: a selectable work scope inside that concept. Each TOML section defines one entry.

Domain slugs (after `NN_`), concept filenames, and entry section names use lowercase kebab-case. Orders are contiguous from `01` with no gaps or duplicate slugs. Entry ids use the slug (`extensions/checkpoint/checkpoint-tool`), not the folder prefix.

```toml
name = "Checkout"
description = "Checkout calculation and order submission"

[orchestration]
description = "Building and submitting a checkout order"
read = ["src/checkout/order.ts"]
show = [
  { path = "src/payments/client.ts", name = "submitPayment" },
]
outline = ["src/checkout/service.ts"]
references = ["test/checkout/service.test.ts"]

[discounts]
description = "Applying coupons and account discounts"
read = ["src/checkout/discounts.ts"]
show = []
outline = []
references = ["test/checkout/discounts.test.ts"]
```

Saved as `.pi/contexts/01_commerce/checkout.toml`, these entries have the IDs `commerce/checkout/orchestration` and `commerce/checkout/discounts`.

## Build a useful taxonomy

Each entry is a **work pack**: enough primary material that selecting only that entry lets an agent start one recurring job with little search. Taxonomy groups packs; it is not a file index. Gold-standard example: `.pi/contexts/01_extensions/checkpoint.toml`.

Classify from the top down:

1. **Domain:** Which stable product or technical area owns this work?
2. **Concept:** Which subsystem inside that area has a clear shared purpose?
3. **Entry:** Which job would someone select on purpose, and which files form its start pack?

Reuse existing terms when they still describe the code honestly. Create, move, split, or merge taxonomy when ownership or subsystem boundaries change. Directory layout can inform the decision, though domains and concepts should describe responsibility rather than copy the source tree.

Keep entries focused on jobs. Names such as `misc`, `shared`, `other`, and a lone `[feature]` bag hide missing boundaries. A broad `all` entry can support deliberate subsystem-wide work, but focused job entries should remain available. If an entry keeps collecting unrelated paths, split it by work scope. If several tiny entries are always selected together, merge them. Overlap across entries is fine when two jobs share files.

Catalog durable code, configuration, tests, standards, and long-lived documentation. Leave scratch files, working plans, interviews, generated output, and rough ideas out of the catalog.

## Choose loading modes

- `read` supplies exact complete file contents. Default for code the agent must edit or deeply understand for that work scope. Prefer complete reads on clean, bounded modules.
- `show` supplies one resolved declaration slice (`path` + `name`, optional `view`) through Explore. Use it for a fat neighbor's thin contract — not to microslice a file you should just `read`. Default `view` is `declaration`. Allowed views: `signature`, `signatureWithDocs`, `declaration`, `declarationWithImports`.
- `outline` supplies structural outlines through Explore. Use it when a full read would drown the job (large or noisy files), not as the default for small clean modules.
- `references` supplies unloaded navigation paths. Default for secondary code, tests, callers, and spill edges the agent should not load unless the task expands.

Every entry declares all four arrays, including empty arrays. Keep injected material small enough that one selected entry is a start pack for real work. A path may appear in only one of `read`, `outline`, and `references`. The same path may also appear in `show` with `outline` or `references` (structure or nav plus hot symbols). When selected entries disagree, precedence is `read`, then `show`, then `outline`, then `references`. A full `read` drops `show` targets for that path.

Do not store raw line ranges in the catalog — they drift. `show` stores durable symbol identity and resolves to current lines at inject time.

`/context` injects the selected entries once, as soon as you confirm the selector. Tau adds one hidden note naming the selected entries and their `references`, then appends complete `read` files, `show` declaration slices, and `outline` structures as visible rows. Those messages stay in the conversation exactly as injected, so the prompt prefix stays cacheable. Run `/context` again to inject more entries.

## Maintain the map

Inspect the existing catalog before placing new paths. Re-evaluate domain, concept, and entry boundaries after moves, ownership changes, or a coherent batch of new work; avoid stuffing paths into the nearest existing bucket.

Run `/context-sync` to update the catalog from uncommitted repository changes (editor is replaced until it finishes; Escape or Ctrl+C cancels). Tau can also delegate to the `context-sync` subagent when automation is enabled. The agent uses normal repo tools, checks every eligible changed file for membership, removes stale paths, and re-evaluates taxonomy and work-pack quality (including `read` / `show` / `outline` / `references`) before editing `.pi/contexts`. Nudge with `/context-sync <note>` when you want a quality rewrite of weak bags, not only dirty-path coverage.
