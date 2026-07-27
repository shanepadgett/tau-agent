# Autoread Removal and Context Redesign

Status: Deferred

This document reserves future work. It does not define implementation yet.

## Direction

Remove autoread as a Tau product concept. Features should not inject complete files merely because path was selected elsewhere.

Redesign reusable project context around Explore outputs and lazy navigation. Selecting project context should provide enough structure to orient agent, then let agent request exact declarations, relationships, or bounded ranges when task requires them.

## Desired outcomes

### `/context` stops loading complete files

Selecting reusable repository context should inject focused orientation, not authoritative complete-file snapshots.

Likely products include:

- File or package outlines
- Lazy paths with relevance notes
- Focused declaration or relationship context where catalog can name it precisely

Exact mix remains undecided.

### Autoread disappears from user and agent language

Human rows and agent guidance should describe actual injected product: outline, declaration context, navigation path, or another Explore result.

There should be no generic “autoread” marker hiding whether complete source or structure was injected.

### Existing consumers migrate deliberately

Current consumers must receive an explicit replacement or lose preload behavior:

- Reusable project context
- Handoff
- Subagents
- Any remaining shared autoread event callers

Context pruning does not wait for this work. It disconnects from autoread first and uses direct outline injections.

### Unsupported paths stay lazy by default

Lack of structural support should not silently fall back to complete-file injection. Agent should receive path and relevance, then choose bounded read appropriate to task.

## Open questions

### What replaces context catalog `files` and `anchors`?

- Keep two loading classes with new meanings?
- Replace them with explicit products such as `outlines`, `symbols`, and `paths`?
- Can catalog stay simple while Explore chooses best orientation product?

### Which Explore products can be persisted safely?

- File outlines only?
- Directory or package outlines?
- Named declarations through `show`?
- Relationship or context packs whose useful scope may change as code changes?

### What happens in handoff and subagents?

- Should known files become outline injections?
- Should parent pass exact retained evidence instead of paths?
- When, if ever, should complete source be copied into isolated child context?

### How should injected structure appear to human?

- One compact row per outline?
- One batch row with expandable paths?
- Should human expansion show outline body or only injection metadata?

### What remains of full `read` overlay?

- Is explicit full `read` still converted to outline?
- Are only ranged reads allowed for supported source?
- How should unsupported text and small configuration files behave?

## Not decided

- New context catalog schema
- Migration of existing `.pi/contexts` files
- Explore injection payloads
- Human renderer design
- Handoff and subagent replacement contracts
- Removal sequence for shared autoread code
