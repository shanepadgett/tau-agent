# Stripped from current Explore (does not carry forward)

This file is normative. Anything listed here is **out of the product**. A rewrite or implementation that reintroduces these without a new explicit product decision is wrong.

Old code, settings, docs, prompts, TUI, worker APIs, and tests that exist only to serve these behaviors are disposable. Do not preserve them “for compatibility.”

---

## Identity and edits

| Stripped | Old role | Replacement |
| --- | --- | --- |
| Numeric session locators | Opaque ints minted by outline/search/relationships; stale-safe handles | Path + name (+ line). Source line ranges in output only |
| Locator session table / worker generation / stale protocol | Invalidate and fail closed on edit/restart | None. Resolve against current bytes + session parse/graph cache |
| `symbol` tool | Resolve locator → signature/body views | `show` (path + name + view) |
| `replace_declaration` | Locator structural whole-decl replace | Harness `patch` / `edit` / `write` |
| `replace_body` | Locator body-range replace | Harness patch/edit/write |
| `insert_declaration` | Locator sibling insert | Harness patch/edit/write |
| `rename_declaration` | Locator rename + ref walk | Harness patch/edit/write + graph tools for finding sites |
| Fresh locator return after edit | Rebind IDs post-mutation | None |
| Locator fields on any tool result | Primary follow-up handle | Path, name, line, signature only |

---

## Explore filesystem clones and read ownership

| Stripped | Old role | Replacement |
| --- | --- | --- |
| Explore `ls` / `find` / `grep` tools | Density wrappers over walk/rg | **Pi built-ins.** Explore does not register these. Future density wrappers only if product re-opens |
| Explore `read` tool | Own full read path, cache, structural policy | **Pi `read`.** Explore applies large-full → outline via `tool_result` hook only ([read-policy.md](cross/read-policy.md), [read.md](fs/read.md)) |
| Complete-file unchanged / diff / recovery cache | Avoid resending bodies; transcript or in-memory baselines | **Gone.** No Explore body baseline store. Pi read results stand (or outline substitution) |
| Transcript-replay / unified-diff baseline reconstruction | Rebuild baselines from chat history | **Gone** |

---

## Read gate and orientation machine

| Stripped | Old role | Replacement |
| --- | --- | --- |
| Read-gate / structural-attempt registry | Block `read` until outline/symbol/search/relationship attempt on fingerprint | [read-policy.md](cross/read-policy.md): large full Pi `read` → outline via result hook; ranges always allowed (capped) |
| `readGate.includeGlobs` / `readGate.excludeGlobs` | Which paths are gated | Deleted settings. All registered source (incl. Markdown) uses threshold outline policy |
| Attempt kinds (`directOutline`, `symbol`, `apiCandidate`, `structuralMatch`, `relationshipLocation`, `relationshipScope`) | Unlock tokens for gate | None |
| `fatalFallback` gate unlock | Allow read after fatal outline failure | None |
| `postPatchDiff` gate exception | Allow complete read after mutation without new attempt | None; policy is threshold-based on current bytes |
| Blocked-read errors (“use structural tools first”) | Fail closed on gated full read | Never. Large full read succeeds as outline (hook replaces content; does not block the tool call) |
| Orientation fingerprint unlock protocol as product surface | Couple tools to gate state | Parse/graph cache may key by content hash internally; not an agent-facing unlock system |

---

## Tools and names removed

| Stripped | Replacement |
| --- | --- |
| `api_discover` | `discover` (same job, no locators) |
| `symbol` | `show` |
| `tests` (relationship tool) | None. No test discovery tool |
| `impact` affected-tests section / test filter flags | None |
| Locator edit tool family (four tools) | None |
| Import-cycle tool | None |
| Full dependency graph dump tool | None (`deps` / `reverse_deps` are file-scoped only) |
| Call-path `trace` tool | None |
| Semantic / embeddings search | None |
| Log `squeeze` | None |
| Structural search-and-rewrite write tool | None (`ast_search` is search-only; writes are harness) |
| Dedicated Explore rename tool | None |

---

## Commands, TUI, telemetry

| Stripped | Old role | Replacement |
| --- | --- | --- |
| `/read-stats` command | TUI panel: token/cost savings, cache modes, gate telemetry | **Gone entirely.** No command, no panel, no savings ledger |
| Read-stats machinery | Counters for baseline/recovery/unchanged/diff, blocked/permitted/fallback reads, bytes deflected, permission breakdown by attempt kind | **Gone.** Do not keep half the counters “just in case” |
| Gate/orientation telemetry product requirements | Feed read-stats and similar | None. Implementation may log privately for debugging; not a specified product surface |
| Structural-orientation event accounting for stats | “Outline-via-read counts for metrics” | None as product requirement |

---

## Prompt / guidance baggage

| Stripped | Replacement |
| --- | --- |
| Guidance that requires locator edits | Guidance: patch/edit/write; `impact` before big change; `show`/range for bodies |
| Guidance that teaches read-gate unlock choreography | Guidance: large full `read` returns outline; use range/`show` |
| Guidance that tells agents to call `symbol` / `api_discover` / `tests` by those old rules | Current tool names and [guidance.md](session/guidance.md) only |
| Guidance that implies Explore owns `ls`/`find`/`grep`/`read` | Harness/Pi owns those; Explore owns structural tools + read overlay |

---

## Settings stripped

- Entire `readGate` object (`includeGlobs`, `excludeGlobs`, and any related knobs)
- Any settings whose only consumer was read-stats, locator TTL, gate behavior, or complete-file cache

Kept settings are only those in [settings.md](cross/settings.md): read thresholds/ranges and context default budget, plus path/traverse concerns that still apply to structural scans.

---

## Agent output meta (strip from model text)

Carry-forward ban on dumping the following into **agent** tool results (see [output-density.md](cross/output-density.md)):

- Search/rank scores and internal relevance numbers
- Engine work counters and timing except real budget-hit notices
- Arg-echo preambles and success banners
- Duplicate full paths under a file/directory header
- Locator fields
- Tutorials / schema names / implementation breadcrumbs in results

Human TUI may still show richer chrome.

## Still in product (do not strip by accident)

- Explore: `outline`, `show`, `discover`, `ast_search`
- Explore: `deps`, `reverse_deps`
- Explore: `callers`, `callees`, `references`, `implementations`
- Explore: `impact`, `context`
- Pi/harness: `ls`, `find`, `grep`, `read` (not Explore-registered)
- Large full Pi `read` of supported source → outline substitution in model-visible result ([read-policy.md](cross/read-policy.md))
- Pre-turn guidance injection
- Autoread (large supported → outline only)
- Shared bounded output + session temp overflow
- Session parse/file-graph/call-graph cache invalidated on mutation
- Engine-registered language extensibility

---

## Implementation instruction

When porting or rewriting:

1. Treat this file as a delete list.
2. If old behavior is not listed under “Still in product,” it does not carry forward.
3. If something old seems useful but is listed stripped (including read-stats, Explore fs clones, complete-file cache), leave it out until product adds a new spec.
