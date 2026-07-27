# Read policy (structural source)

## Goal

- Stop whole-file body dumps of large supported source without a separate gate machine and without Explore owning `read`.
- Small files stay cheap full reads (Pi `read` unchanged).
- Large full reads become outline in **model-visible** tool results.
- Bodies are fetched with ranged harness `read` or Explore `show`.

## Ownership

- **Harness/Pi** owns the `read` tool registration and normal execution (text, images, binary fallback, ranges).
- **Explore** owns the structural overlay: after a qualifying full `read` completes, replace model-visible content with outline before the result is committed to context.
- Explore must **not** register a competing `read` tool for this policy.
- Explore must **not** `{ block: true }` large full reads. Blocking is the stripped gate. Substitution is a successful result reshape.

## Applies to

- Paths whose language is **engine-registered** for structural shape — including Markdown (heading outline).
- Unregistered languages, binary, and images follow ordinary Pi `read` behavior (no outline substitution).
- New registered languages automatically fall under the same threshold/range rules — no per-language read policy. No Markdown special-case pass-through.

## Enable switch

- `explore.read.enabled` default **true** ([settings.md](settings.md)).
- When `false`, Explore runs **no** structural overlay: full and ranged Pi `read` results stand as Pi produced them; autoread does not outline-substitute large supported source.
- When `true`, the threshold and range rules below apply.

## Thresholds

- `structureThresholdLines` default **200** ([settings.md](settings.md)).
- `maxRangeLines` default **200**.

Line count is the file’s current newline-based line count.

## Full read (no offset/limit, or whole-file intent)

| File | Model-visible result |
| --- | --- |
| Registered source (incl. Markdown), line count ≤ threshold | Full file text from Pi `read` (subject to Pi/shared output bounds) |
| Registered source (incl. Markdown), line count > threshold | **Outline only** for that file ([outline.md](../shape/outline.md) shape). Code: no method/function bodies. Markdown: headings/section ranges only. One-line instruction to use ranged `read` or [show.md](../shape/show.md) for bodies/sections ([output-density.md](output-density.md)) |
| Unregistered / non-text | Normal Pi read path |

Outline-on-full-read is a successful result, not an error. Full file bytes from that call must **not** remain in model-visible content after the overlay runs.

Implementation may read bytes on disk before substitution; that is an implementation detail. Product requirement is context content, not skipping the kernel read.

## Ranged read (`offset` and/or `limit`)

- Always allowed on supported source (no prior outline required).
- The returned slice may contain at most `maxRangeLines` lines.
- If the caller asks for more than `maxRangeLines`, error and tell them to shrink the range.
- `offset` beyond EOF → error naming total lines (Pi or overlay; one clear error).
- Normal head byte/line output limits still apply to the slice.

## After mutation

- No special gate exception.
- Next full read uses new bytes: small → full text; large → new outline.
- Ranges still capped.

## Explicitly absent

- No Explore `read` tool
- No blocked-read error path / `tool_call` block for size policy
- No attempt-registry unlock protocol
- No complete-file unchanged/diff/recovery cache
- No orientation/gate telemetry product surface
- No read-stats accounting for outline-substituted reads

See [stripped.md](../stripped.md).

## Non-goals

- Not a secrets permission system
- Does not replace or wrap `ls` / `find` / `grep`
