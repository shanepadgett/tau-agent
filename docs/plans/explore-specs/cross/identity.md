# Target identity

## Rule

Explore never mints or consumes numeric session locators ([stripped.md](../stripped.md)).

Every symbol-targeted tool binds a declaration with:

1. `path` — file containing the declaration (absolute or cwd-relative), when known
2. `name` — declaration name; may be dotted (`Type.method`)
3. `line` — optional 1-indexed line to pin one candidate when the caller already knows it
4. `scope` / search `path` — directory scope for repo-wide tools when the defining file is not yet known

## Resolution

- Resolve against current file bytes (and session graph cache derived from them).
- Prefer exact name match within the given file when `path` is set.
- Dotted names match qualified / owner.member forms the language adapter understands.
- When `line` is set, keep only candidates whose declaration range covers that line (or whose start line equals it, per adapter consistency — one rule, applied uniformly).

## Ambiguity

- Zero matches → explicit empty / not-found error appropriate to the tool.
- Multiple matches → return a bounded candidate list. Each candidate includes at least:
  - path
  - line range
  - kind
  - signature (no body)
  - name / qualified name when known
- Do not silently pick a winner.
- Do not mint an ID for later use. Caller disambiguates with tighter `path`, `name`, or `line` on the next call.

## Display

- Outline and other shape outputs show declaration line ranges as source lines (`Lstart-end` or equivalent), not session IDs ([output-density.md](output-density.md)).
- Graph and composite hits identify sites with path + line (+ name/kind), never locators.

## Consumers

- [show.md](../shape/show.md), [relationships.md](../graph/relationships.md), [impact.md](../graph/impact.md), [context.md](../graph/context.md), and candidate lists from [discover.md](../shape/discover.md) / ambiguity stops.

## Non-goals

- No stale-ID protocol
- No locator generation tables
- No “fresh locator after edit” round-trip
