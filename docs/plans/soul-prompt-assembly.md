# Soul prompt assembly

Architecture proposal for review. Implementation has not started.

## Contract

Soul replaces Pi's default prompt with the tagged sections in `soul-prompt-draft.txt`. Shared instructions are hardcoded. Tools, skills, documentation, project instructions, and environment facts come from code. Remove the overseer entirely: no review calls, hidden nudges, settings, or replacement reviewer.

Between successful compactions, Tau must preserve the request prefix already sent to the model. New information is appended, not inserted into or substituted for earlier content. This covers prompt text, tool declarations, and replayed messages—not just Soul's string.

Provider cache expiration and eviction are outside Tau's control. The contract is no Tau-caused prefix invalidation during continued work with the same model and provider.

## Systems and ownership

| System | Change | Responsibility |
| --- | --- | --- |
| Soul | Expand | Own section order, render the baseline, save and restore prompt state, admit later context updates |
| Pi prompt lifecycle | Integrate | Supply loaded resources and tool metadata; deliver Soul's prompt through supported hooks |
| Existing Tau extensions | Refactor | Supply owned content instead of concatenating the system prompt |
| Tool loading | Integrate | Keep capability changes from rewriting previously sent tool declarations |
| Cache diagnostics | Reuse | Check the final provider payload, including transformations after Soul |

Keep assembly and lifecycle code inside Soul. Reuse Pi's structured inputs for contributions. Do not build a general plugin registry or copy OpenCode's state framework.

## Prompt layout

```text
Fixed instructions
  communication → discussion → planning → execution → coding
Captured context
  tools → tool-guidance → skills → documentation
  → project-context → environment
Additional contributed instructions
  named, tagged sections in a fixed order
```

Preserve user-supplied and extension-supplied instructions as identified contributions; do not silently discard them when replacing Pi's default. Every contribution follows the same snapshot rule.

The date and directory listing are captured together. They remain unchanged until the next baseline. No per-turn date formatting or directory scan.

## State and request flow

A generation is the interval from initial capture, or successful compaction, to the next successful compaction.

```text
No saved generation
  → collect contributions → render and persist baseline → Active

Active + ordinary request
  → reuse exact saved baseline and prior updates
  → append newly admitted updates → send request

Active + successful compaction
  → collect current contributions → persist new baseline
  → send first post-compaction request using that baseline

Active + failed or cancelled compaction
  → retain current generation

Reload / resume / fork / tree navigation
  → restore the generation and updates on the selected branch
```

Persist the baseline text, generation boundary, and last admitted contribution values in session entries. Persist each model-visible update once. Do not regenerate historical update text from current settings during replay.

Publish a new baseline only after all required contributions are available. A failed refresh retains the previous generation rather than installing a partial prompt.

The delivery point must run before every model request. Updating only in `before_agent_start` is insufficient: automatic compaction can retry inside an existing run. Select one prompt-delivery path; do not combine a forced prompt with an earlier hook whose changes that forced prompt overwrites.

## Contribution changes

| Owner | Destination and behavior |
| --- | --- |
| `soul/prompt.ts` | Replace existing behavior blocks with the draft |
| `runtime-context` | Supply one captured environment value per generation |
| Explore | Supply fixed tool guidance through structured contributions |
| `tau-help` | Supply documentation guidance and resolved paths |
| Subagent | Capture initial availability; append durable availability updates when agents change |
| `silent-command-runner` | Capture check instructions; append changed instructions when configuration changes |
| `tool-approval` | Capture approval guidance; append policy updates without delaying actual enforcement |
| Tool registrations | Supply descriptions and guidelines from their existing metadata |

Remove the whole-prompt append handlers as their contributions are wired into assembly. One component owns final prompt construction.

Changes to fixed instructions wait for compaction. Operational updates are admitted at the end of history only when the provider preserves their position. If an update cannot be represented without rewriting the prefix, it cannot be applied silently.

## Implementation order

### 1. Resolve the Pi delivery boundary

Trace Pi's prompt projection and deferred-tool serialization through the final Anthropic and OpenAI payloads. Produce one concrete hook sequence covering initial capture, normal calls, tool activation, and immediate post-compaction retries.

The result must establish where system updates and new tool declarations appear. Appending a tool announcement while changing a leading schema array does not meet the contract. If Pi lacks the required mechanism, identify the precise Pi change and bring that scope change for approval before implementing Soul.

### 2. Specify and implement the generation lifecycle

After architecture approval and the boundary trace, define the persisted generation and contribution types, the renderer inputs, and the hook call path. Implement capture, branch-aware restoration, append-only updates, and successful-compaction refresh as one lifecycle.

Wire the shared draft instructions into this lifecycle. Do not stage an unused parallel prompt system.

Delete the overseer runtime and its registration, prompt, settings, and documentation. Regenerate the settings schema through the existing workflow and clean obsolete context references. Do not migrate it into the new update system.

### 3. Migrate contributions

Move each owner in the table onto the assembly path. Preserve existing behavior while removing independent prompt concatenation. Update Soul and affected extension documentation in the same change.

### 4. Validate the serialized requests

Use existing cache diagnostics to compare consecutive provider payloads. Verify that ordinary turns, midnight, capability changes, and reload do not alter previously sent content. Verify that only successful compaction installs a fresh baseline, including automatic retries. Check restoration on resume and branch navigation.

Audit remaining request-time history transformations: removing a previously sent message can invalidate a prefix even with an unchanged system prompt.

Do not add tests. Tool changes require `/reload` before interactive validation.

## Reference basis

Pi: `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` documents structured inputs, full prompt replacement, request hooks, and compaction events.

OpenCode: <https://anoma.ly/notes/opencode-reloaded/> describes deterministic contribution rebuilding. In `/Users/shanepadgett/.local/share/tau-agent/references/opencode`, `packages/core/src/system-context/index.ts` and `packages/core/src/session/context-epoch.ts` implement saved baselines and appended context updates. Use that pattern, not its complete framework. Its fallback replacements without compaction do not meet Tau's contract.
