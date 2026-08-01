# Standards nudge extension (local)

Repo-local extension idea. Pairs with agent-ready standards docs. Not a Tau core feature by default: mapping is per-repo shape.

## Problem

Standards by work type (UI, features, HTTP, etc.) should stay out of AGENTS.md. Context packs can attach the right docs when the human picks a work area up front. That misses the other common path: agent explores first, touches several areas, only some of which it will edit.

Dumping every matching standard on first glance wastes context. Saying nothing means the agent freestyles.

## Idea

Watch tool reads (and similar). When the agent opens files under a configured area, nudge:

- You looked at paths in area X.
- If you will change or implement here, read standard S before editing.
- If this was reference only, skip S.

Do not paste the standard into context automatically. Point at it. Agent pulls when intent is real work in that area.

Exploration stays natural. No upfront essay of "when UI do A, when API do B."

## Why local extension

- Path → standard map is repo-specific (folder layout, doc paths, work types).
- Which tools count as "reading" may depend on the harness tool set.
- Thresholds and wording are house taste.
- Lives next to the repo's standards tree; ships with the project, not global Tau.

## Behavior sketch

Config: list of rules. Each rule has path matchers (globs/prefixes), standard path(s), short area label, optional notes.

Two tiers. Edits always go through; never block the tool on missing standards.

### Soft pointer on read

On read-like tool results (read, and maybe outline/show if useful):

1. Match paths against rules.
2. Dedupe per area per session (once until standard is read or edit-tier fires).
3. Small advisory only: area + standard path + "read this if you will work here; skip if reference only."
4. Do not inline the standard.

### Align-after-edit if standard was skipped

On edit/write/patch under a matched area when the standard was not already read (and not already injected this session for that area):

1. Allow the edit to complete normally.
2. After the tool result, inject the standard file contents into context.
3. Short nudge: you edited area X without loading its standard first; here it is — check the change against it and fix if needed.
4. Mark area satisfied for further injects (do not re-dump the doc every subsequent edit). Optional light reminder on later edits in the same area if you want a one-liner without re-attaching the file.

Multi-area exploration can yield multiple soft pointers. Multi-area edits can inject multiple standards once each. Agent still only pays full doc cost where it actually wrote (or where a context pack preloaded it).

## Intent heuristic (keep dumb at first)

Cannot know intent perfectly. Cheap signals:

- Read only → soft path pointer once. No file inject.
- Edit without prior standard read → allow edit, inject standard + align nudge once.
- Standard already read or injected this session → silence.
- Human-selected context pack already injected that standard → silence.

Avoid model calls to classify intent. Rules + session memory.

## Non-goals (v1)

- Blocking edits until the standard is read
- Inlining full standards on mere reads or on every edit
- Replacing context packs (complement: packs = planned work; nudges = discovered work)
- Generic across all repos without config
- Teaching architecture beyond what the standards docs already say

## Open questions

- Which tools fire the read matcher (read only vs outline/show)?
- Hidden advisory vs visible chat for the soft pointer
- Inject vehicle after edit (hidden custom message vs visible)
- Same-turn batch: edit lands in one tool batch before any inject — ensure post-batch inject still runs before next model call
- Overlap when context pack and nudge map both define the same standard
- Rules home: extension settings, TOML next to standards, or context catalog metadata?

## Relation to agent-ready checklist

Readiness: standards exist, are split by work type, and have *some* delivery path (AGENTS pointer, context packs, and/or this nudge map). This extension is one delivery mechanism, optional, best when agents often explore before the human scopes the work.

Session readiness harvest (`docs/plans/session-readiness-harvest.md`) may propose new path→standard rules when a session showed the agent working an area with no attached law.
