# Read policy (structural source)

## Goal

- Stop whole-file body dumps of large supported source without a separate gate machine.
- Small files stay cheap full reads.
- Large full reads become outline.
- Bodies are fetched with ranged `read` or `show`.

## Applies to

- Paths whose language is **worker-registered** for structural shape and whose extension is not Markdown.
- Markdown is always full-read allowed (structural `outline` / `show` still available when asked).
- Unregistered languages, binary, and images follow ordinary `read` behavior (no outline substitution).
- New registered languages automatically fall under the same threshold/range rules — no per-language read policy.

## Thresholds

- `structureThresholdLines` default **200** ([settings.md](settings.md)).
- `maxRangeLines` default **200**.

Line count is the file’s current newline-based line count.

## Full read (no offset/limit)

| File | Result |
| --- | --- |
| Supported source, line count ≤ threshold | Full file text (subject to normal output bounds and complete-file cache modes in [read.md](../fs/read.md)) |
| Supported source, line count > threshold | **Outline only** for that file ([outline.md](../shape/outline.md) shape). No method/function bodies. One-line instruction to use ranged `read` or [show.md](../shape/show.md) for bodies ([output-density.md](output-density.md)) |
| Markdown / unsupported / non-text | Normal read path |

Outline-on-full-read is a successful result, not an error.

## Ranged read (`offset` and/or `limit`)

- Always allowed on supported source (no prior outline required).
- The returned slice may contain at most `maxRangeLines` lines.
- If the caller asks for more than `maxRangeLines`, error and tell them to shrink the range.
- `offset` beyond EOF → error naming total lines.
- Normal head byte/line output limits still apply to the slice.

## After mutation

- No special gate exception.
- Next full read uses new bytes: small → full text; large → new outline.
- Ranges still capped.

## Explicitly absent

- No blocked-read error path
- No attempt-registry unlock protocol
- No orientation/gate telemetry product surface
- No read-stats accounting for outline-substituted reads

See [stripped.md](../stripped.md).

## Non-goals

- Not a secrets permission system
- Does not block `ls` / `find` / `grep`
- Does not require a prior structural tool call before ranged read
- Does not feed a savings dashboard
