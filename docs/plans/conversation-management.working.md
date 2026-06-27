# Conversation Management Working Notes

Status: rough alignment. Not implementation plan yet.

Use this file for the conversation. Human can add bracket comments anywhere:

- `[human: ...]` for notes or objections.
- `[question: ...]` for things Rok should answer.
- `[decision: ...]` when something should move to Settled.

Rok will promote stable bits into Settled and leave uncertain bits below.

## Settled So Far

- We want a cohesive system for long conversations, not three separate clever tricks.
- Compaction should preserve continuation: what to do next, what constraints matter, and how to recover exact detail.
- Search working memory already owns stale/forgotten search evidence. Conversation management should use that concept instead of inventing a parallel memory swamp.
- Goal should be explicit state, not guessed later from user messages during compaction.

## Reference Notes Read So Far

- DCP README: compress replaces stale ranges/messages with summaries; dedupes repeated tool calls; purges old errored tool inputs while preserving error messages. Source: `/Users/shanepadgett/.local/share/tau-agent/references/opencode-dynamic-context-pruning/README.md:31-52`.
- pi-mrc README: compact into minimum viable summary plus KEEP chunks; stash recoverable detail behind exact handles; inject dynamic refs late before current user prompt. Source: `/Users/shanepadgett/.local/share/tau-agent/references/pi-model-reference-compactor/README.md:9-17`, `:82-143`.
- pi-mrc README: source refs should be locators, not stale copied code; exact unrecoverable facts stay in prompt or lookup. Source: `/Users/shanepadgett/.local/share/tau-agent/references/pi-model-reference-compactor/README.md:145-164`, `:286-296`.
- pi-vcc README: deterministic algorithmic compaction, brief transcript, semantic sections, active-lineage recall. Useful baseline, but regex-extracted goal/context sections look brittle for our goal idea. Source: `/Users/shanepadgett/.local/share/tau-agent/references/pi-vcc/README.md:13-52`, `:86-140`, `:142-194`.
- Tau Search README: `workingMemory` can prune stale or forgotten search evidence and enables `forget`. Source: `src/extensions/search/README.md:1-7`.

## Rok's Current Small Shape

Visible continuation state:

- active goal
- user constraints and decisions
- files touched / likely next files
- blockers and failing evidence signatures
- next action
- recent transcript tail untouched

Hidden recoverable state:

- exact tool outputs worth keeping
- exact errors, benchmark/test results, IDs, user decisions
- important reads as source locators, not copied code bodies
- deleted or dirty context not recoverable from repo files
- handles for lookup when visible state is insufficient

Active cleanup:

- stale search evidence drops from active prompt
- repeated reads/tool outputs collapse
- old errors keep signature visible, body behind handle
- source bodies become path/symbol locators

Core rule: summary tells agent what to do next. Handles let agent recover why.

## Goal Management Idea

Rough candidate shape:

- Every session has one active goal, even exploration/explanation sessions.
- On a fresh session, derive a goal from the first user message with a small model completion.
- Show a small TUI for approving, editing, or giving feedback and regenerating the goal.
- Candidate negotiation stays out of normal model context until the user accepts a goal.
- Accepted goal is recorded as explicit session state and survives immediate compaction.
- Agent gets a goal management tool for goal updates during scope changes.
- Goal set/update appears in chat through a custom rendered message so the user can see what changed.
- Compaction reads goal state directly instead of re-extracting goal from transcript.

Rok lean:

- Goal is durable state plus visible chat events.
- Goal candidate text is disposable until approved.
- Compactor trusts accepted goal state.
- Agent may propose/update goal, but user-visible history should make changes obvious.

## Public Surface Candidates Needing Approval Before Implementation

- Automatic first-message goal extraction.
- Goal approval/edit/regenerate TUI.
- Goal management tool exposed to the agent.
- Custom-rendered goal set/update chat messages.
- How accepted goal is injected into compaction / active prompt.

## Open Questions

- Does first-message goal approval block the first real agent turn, or can the agent start while the goal is pending?
- Can the agent update the goal directly, or should it propose a goal update that the user approves?
- Is there exactly one active goal, or one active goal plus completed prior goals?
- What means “goal reached”: user says done, agent marks done, or both?
- Should goal text be terse operational state, user-facing prose, or both?

## Watchouts

- Avoid pi-vcc-style regex goal guessing as the source of truth.
- Avoid DCP-size config/policy sprawl at the start.
- Avoid fuzzy transcript recall as the first recovery mechanism. Exact handles first.
- Do not let copied source snippets become authoritative after files change.
