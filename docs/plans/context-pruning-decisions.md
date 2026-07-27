# Context Pruning Decisions

Status: Settled for implementation

Implementation direction: [Working Memory Replacement Plan](working-memory-replacement-plan.md)

This document records product decisions for simplifying context pruning. It stays focused on observable outcomes: what agent can request, what agent receives afterward, and what human sees. Architecture and implementation follow only after contract is settled.

## Desired outcome

Context pruning creates a hard checkpoint. Everything before checkpoint leaves future model context unless agent explicitly chooses to carry it forward.

System should make pruning cheap and decisive. It must not provide an easy path to reload broad file contents and recreate context that was removed.

Goal is continuous work with managed working memory, not smallest possible context after every checkpoint.

## Confirmed decisions

### Agent can retain any valuable context entry

Retention is not limited to tool calls. Agent must be able to retain whichever earlier entries matter, including assistant messages, tool exchanges, and other useful context entries.

### Agent-facing tool is `working_memory`

Name should reinforce intended behavior: selectively manage active working memory, not prune toward smallest token count.

`working_memory` affects future model context in current conversation branch. It is not durable cross-session memory, a knowledge store, or a replacement for saved project documentation. Saved conversation remains unchanged.

### Deferred files remain lazy

Agent can carry forward a file path with:

- Why file is not relevant now
- When file becomes relevant

Deferring file does not read file or inject its contents.

### Pruning must not autoread complete source files

Complete-file autoread defeats pruning, especially when agent previously read only focused ranges.

When file carry-forward requests need file knowledge, system should use Explore to provide structure only. Agent can then request a focused range or declaration if needed.

No percentage-based autoread policy or similar heuristic should decide how much source to reload.

### Contract before architecture

We will agree on these physical outcomes before designing implementation:

- Agent-facing tool input
- Agent-visible result
- Human-visible tool call and result
- Exact future context after checkpoint

### Checkpoint call owns continuation note

Agent should not need to publish a separate prose message immediately before pruning. Tool input carries one concise continuation note describing working state that must survive checkpoint.

This is not hidden chain-of-thought or a transcript of reasoning. It is a compact handoff containing durable conclusions, active constraints, unresolved matters, and next action.

Future model context should contain one canonical Markdown rendering of continuation note. It should not pay for same note once in tool arguments and again in tool result.

### Agent-visible result is compact text, not JSON

Tool input remains structured because agent must call tool with a schema. Tool result should be concise Markdown-like text optimized for future model context.

Result does not repeat successful selections, list automatically injected file outlines, or expose bookkeeping. Retained entries and outline injections already provide that information. Counts and status metadata belong in human renderer unless agent needs them to recover from failure.

Result carries only information not otherwise present in future context:

- Canonical continuation note
- Deferred paths, why they are deferred, and when to reconsider them
- Warnings requiring agent action
- Minimal success acknowledgement when no such information exists

### File outlines arrive as context injections

Requested outlines are injected directly into future model context. Checkpoint result does not announce, summarize, wrap, or duplicate them.

These are outline injections, not autoreads. Human transcript may render each injection as a compact file row similar to current autoread rows, but label and behavior must describe an outline.

### Context pruning disconnects from autoread

Context-pruning change stops requesting, preparing, retaining, or tracking autoread entries. Autoread can remain temporarily for features that still depend on it, without being part of new checkpoint contract.

Reusable project context now uses branch-local ephemeral read/outline/reference projections. Removing autoread from remaining Tau consumers stays deferred to [Autoread Removal and Context Redesign](autoread-removal-context-redesign.md).

### Pruning nudges remain advisory

No nudge forces checkpoint. Agent may correctly keep current context when pruning would hurt continuity. Higher tiers use stronger language but do not turn tool use into hard requirement.

Crossing boundary asks agent to reassess working memory. It is not token target and does not mean context should be scrubbed immediately.

### Prune known waste, not active working set

Agent should remove evidence it already knows is irrelevant, obsolete, duplicated, or tied to abandoned exploration. Large dead-end reads are especially valuable pruning targets.

Agent should keep evidence still supporting active exploration or likely near-term work. Pruning useful evidence only to reread it is failure: it increases cost and disrupts continuity.

Initial exploration may legitimately continue through one or more nudge boundaries. Agent can still prune throwaway branches during that exploration without pretending whole exploration is complete.

### Carry information at cheapest useful fidelity

For each useful item, agent chooses cheapest form that avoids likely reacquisition:

- Keep exact context when details remain actively useful or expensive to recover.
- Request outline when only file structure and navigation remain useful.
- Defer path when file is irrelevant now but has a known condition for reconsideration.
- Carry nothing when evidence has no expected future value.

Continuation note carries conclusions and next action. It should not duplicate retained evidence or become a substitute for keeping exact details that will immediately be needed again.

### Nudge interval and tiers are configurable

Default boundaries occur every 40,000 active-context tokens rather than current 30,000. Default instruction ladder therefore steps up at 40k, 80k, and 120k.

Boundary interval and ordered tier instructions remain configurable. Once final instruction tier is reached, later boundaries repeat strongest instruction.

### There are two nudge moments

Boundary nudge appears once when active context crosses each interval during ongoing work. It remains visible to human and model.

Agent-start nudge is evaluated on every `before_agent_start`. If active context is already above a configured tier, model receives highest applicable tier instruction. Human sees no marker or message. This nudge repeats on every later agent start while context remains above a tier.

Both moments use same configured tier instructions. Agent-start nudge does not inspect prompt source, wait for another boundary crossing, or suppress itself merely because model saw that tier earlier.

## Working contract

This section is a proposal, not yet a decision.

### Candidate `working_memory` input

```json
{
  "continuation": "Current state: context-pruning contract is being simplified.\n\nDurable decisions:\n- Autoread never carries complete source files.\n- Requested outlines arrive as separate context injections.\n\nNext: settle retention selectors and atomicity.",
  "keep": ["a17", "t23", "u04"],
  "outlineFiles": [
    "packages/agent/extensions/working-memory/checkpoint.ts"
  ],
  "deferFiles": [
    {
      "path": "packages/agent/extensions/working-memory/render.ts",
      "reason": "Display behavior is outside current decision",
      "relevantWhen": "Checkpoint behavior is settled"
    }
  ]
}
```

Intent:

- `continuation` carries compact working state and next action across checkpoint.
- `keep` retains selected prior context.
- `outlineFiles` carries current file structure without complete source.
- `deferFiles` carries only lazy navigation advice.

### Candidate nudge settings

```json
{
  "nudgeEveryTokens": 40000,
  "nudgeInstructions": [
    "Reassess working memory. Continue coherent exploration when its evidence remains useful; otherwise prune known dead ends, obsolete outputs, and other context with no expected value.",
    "Context is materially larger. Prune stale or bulky irrelevant evidence when safe, but keep active working evidence that would otherwise need to be reread.",
    "Strongly reassess before more broad work. Remove accumulated waste and carry useful information at cheapest sufficient fidelity without scrubbing the active working set."
  ]
}
```

Exact default wording remains open. Later interval boundaries repeat final instruction.

### Candidate agent-visible result

```text
## Continue

Current state: context-pruning contract is being simplified.

Durable decisions:

- Autoread never carries complete source files.
- Requested outlines arrive as separate context injections.

Next: settle retention selectors and atomicity.

## Deferred files

- `packages/agent/extensions/working-memory/render.ts` — Display behavior is outside current decision. Reconsider when checkpoint behavior is settled.
```

Empty sections are omitted. Warnings identify only requests that failed or did not survive.

### Candidate human-visible result

Collapsed:

```text
Checkpoint · kept 2 · outlined 1 · deferred 1 · removed 31
```

Expanded view would show short previews and paths, not internal bookkeeping or complete outline bodies.

### Candidate future context

After checkpoint, agent receives:

1. Selected earlier entries in chronological order
2. One canonical Markdown continuation note from checkpoint call
3. Deferred-file advice and actionable warnings in same compact note
4. Requested file outlines as direct context injections
5. All messages created after checkpoint

Unselected earlier context is absent. Saved conversation remains unchanged.

## Open questions

### What is selectable?

- Does “any context entry” include user messages, custom messages, compaction summaries, and prior autoread entries?
- Is selection at whole-message level, content-block level, or both?
- When assistant message contains several parallel tool calls, can agent retain message prose independently from each tool exchange?

### How does agent name an entry?

- Should every selectable item have short stable reference visible only to model?
- Can existing tool-call IDs remain selectors while other entries receive separate references?
- Should references survive branch changes and compaction?

### What comes with retained entries?

- Should selecting tool call or result always retain complete valid exchange?
- Should selecting assistant message automatically retain tool exchanges embedded in that message?
- Should retained entries remain byte-for-byte equivalent to prior model context?

### What ambient context survives automatically?

- Should hidden Runtime Context date and root snapshot always remain available after checkpoint without explicit retention?
- Which other extension-injected messages are ambient rather than prunable conversation evidence?
- Should root snapshot continue unchanged, be refreshed, or be reconsidered separately from context pruning?

### What does file carry-forward mean?

- Should API explicitly request `outlineFiles`, or retain a more general file-carry-forward name whose result is always outline-only?
- Should outlines always represent current disk state or evidence as it existed when originally read?

### What happens when Explore cannot outline a path?

- Carry path only and require explicit ranged read?
- Return warning without carrying path?
- Are complete reads ever allowed for unsupported or very small files?

### How broad is autoread restriction?

- What should happen to an old complete autoread selected for retention: current outline, old outline, path only, or rejection?

### What shape should continuation note have?

- Is one freeform Markdown-capable string enough?
- Should continuation note be required even when retained entries already contain all needed state?
- Which content is required: current goal, durable decisions, active constraints, unresolved matters, next action?
- Should human see full continuation note by default or only in expanded tool result?

### What does human see?

- Which counts belong in collapsed result?
- What previews belong in expanded result?
- Should pruned transcript rows remain visually marked?
- Should file outlines create separate visible rows?

### What automation remains?

- Keep `/prune` behavior unchanged?
- What exact default wording should each 40k tier use?
- Should visible boundary nudge repeat after checkpoint if retained context remains above same tier, or wait until a higher boundary?

### How are failures handled?

- Does one invalid selection block checkpoint or become warning?
- Does failed outline block checkpoint?
- What result tells agent that requested evidence did not survive?

## Explicitly out of scope for now

- Internal state representation
- Session replay implementation
- Projection algorithm
- Explorer integration mechanics
- Migration or backward compatibility
- Test structure

These become relevant after input, output, human display, and future-context behavior are agreed.
