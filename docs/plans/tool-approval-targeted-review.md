# Targeted tool approval review

Status: implemented. Routing and initial approval share one review using the existing quick-tier models. Live approval verification requires user `/reload`.

## Goals

Inspect directly referenced execution targets without repository exploration. Keep ordinary requests to one model review. Explain approval requests in language a new engineer can understand.

## Architecture

Expand the existing tool-approval extension with bounded evidence collection. Keep the reviewer isolated from the main agent's tools and conversation. Do not introduce a general research agent or change reviewer model selection and fallback policy.

Call path:

```text
tool_call
  -> resolve script_runner source / existing bash allowlist
  -> identify direct execution references without reading source files
  -> reviewer: approve, ask user, or inspect
  -> deterministic checks prevent approval of uninspected local execution
  -> at most one bounded evidence collection and final model review
  -> validate evidence freshness
  -> existing automatic approval or human confirmation
```

File reads happen in the approval extension, not through arbitrary reviewer tools. No shell execution, directory listings, repository search, or network requests are available to the reviewer.

## Evidence boundary

Use the installed shell parser to resolve supported literal commands and working-directory changes. Read exact targets for Python, Node, shell execution, source commands, and direct local executables. For supported package tasks, read the exact package manifest and supply only the requested script definition, relevant lifecycle hooks, and relevant execution configuration. Resolve its literal local execution targets. Do not run the task to discover its behavior.

Start with common literal invocation forms. Dynamic paths, unsupported wrappers, generated execution targets, and unresolved executable dependencies are explicit evidence gaps, not guessed-safe commands. Ordinary installed development tools are not recursively audited; preserve the existing trusted-tool assumption and document this limit.

The initial reviewer can request exact referenced files. The host checks each request against concrete references in the request. During the single evidence collection, follow supported direct local imports and subprocess targets within the same budget. Support explicit local relative imports initially; unsupported language resolution is an evidence gap. No arbitrary path requests or open-ended requests to find related files. The final reviewer cannot request another inspection round.

Total limits per approval: four files, 48 KiB of source, one follow-up review, and two seconds of evidence collection. Model latency is separate from the file-read deadline. Read regular files only with bounded reads; reject special files. Detect overflow rather than silently treating partial code as complete. Source read errors, exhausted limits, or unresolved material execution behavior require human approval with a specific explanation of the gap. Metadata resolution also has a 32-reference work limit.

Do not escalate every import. Follow dependencies needed to assess an execution effect, including relevant top-level import behavior. State clearly that this remains a risk filter, not proof of arbitrary code safety.

## Types and code changes

Add a private evidence module under `packages/agent/extensions/tool-approval/`, wired immediately from `index.ts`.

```ts
interface ReviewedFile {
  path: string; // canonical absolute path
  fingerprint: string;
  source: string;
}

interface ReviewEvidence {
  files: ReviewedFile[];
  gaps: string[];
}

type ReviewerResponse =
  | { decision: "inspect"; summary: string; references: string[]; reason: string }
  | ToolReview;
```

Update the local review schema and validator to support these two actions. Reuse `generateToolValidated` for each round; do not add a general tool-execution loop to shared model fallback. The final round permits only a decision. Validate requested references before reading; a failed reference check becomes an evidence gap.

The evidence collector takes the actual execution working directory, resolved tool input, and cancellation signal. Evidence and outcomes belong to a single review request, not a session-wide approval cache. Python file imports keep their original search root; Node file imports use the canonical source directory. script_runner's temporary source directory is modeled separately from its process working directory. npm execution settings are selected from `.npmrc` without sending registry credentials; unresolved Yarn executable configuration requires confirmation.

Internal evidence is inherently bounded by the collection limits; it is not an unbounded user-facing tool result. Keep temporary source copies and additional public tools out of this change.

## Approval lifetime

Extend each cached batch review with its evidence fingerprints. Before acting on its decision, recheck the inspected paths, their canonical resolution, and bounded content fingerprints. If changed, discard the outcome and review current evidence once; repeated changes block execution until resubmission. Human confirmation also needs a freshness check before allowing execution; changed evidence blocks the request and requires resubmission for fresh confirmation. Track absent local import candidates so newly created modules also invalidate approval.

This closes stale batch decisions but does not make file review and arbitrary shell execution atomic. Do not claim it prevents adversarial concurrent changes. Sandboxing or execution binding is separate work. Preserve script_runner's existing exact-source approval binding.

## Explanation contract

Keep `summary` and `reason` but give them distinct responsibilities:

- Summary: the main real-world effect, its target, and who or what is affected.
- Reason: why human approval is needed, the possible loss or interruption, and recovery difficulty or uncertainty.

Use everyday words. Keep important resource names and familiar abbreviations. Avoid API inventories and step-by-step script narration. Do not invent consequences, environment identity, or recovery guarantees. Combine the fields into one concise approval paragraph without repetition. Evidence gaps must say what could not be checked.

Example: "This will shut down the application running in AWS and remove its deployment resources. Anyone using it could lose access, and restoring it may require redeploying. Approval is required because this changes a shared environment."

Update the review prompt and schema descriptions in `index.ts`. Reuse the existing approval panel without changing its TUI.

## Cache behavior

Keep reviewer instructions in a stable leading system message and the tool schema stable before mutable request JSON and evidence. Sort evidence deterministically and keep unchanged source fingerprints stable. Follow-up requests preserve the original messages and append an evidence message with the final-round instruction. Shared tool generation now accepts messages as well as text and an actual caller-supplied session ID. Both approval stages use a stable session-scoped approval key, including fallback attempts. Provider conversion keeps the system/tool prefix stable; Anthropic moves its conversation breakpoint to the final user block, so do not claim the entire initial request remains cached. Do not change the main agent's tool loadout or cached conversation.

## Verification and documentation

Do not add or modify tests. Inspect existing cases and perform targeted manual checks after user `/reload`: inline safe code, safe file execution, destructive file execution, one relevant local import, a package task, unreadable or oversized source, a dynamic target, and a changed batch-reviewed file. Check approval wording for effect, target, risk, and recovery; compare model calls and latency for direct versus follow-up paths. Inspect final serialized reviewer requests for stable prefixes and bounded evidence.

Update `packages/agent/extensions/tool-approval/README.md` and `packages/agent/extensions/tau-help/help.md` with the inspection behavior and its limits. No settings or generated schema changes are planned. After implementation, ask whether to delete this plan.

Completed source checks: changed modules load under Node's TypeScript stripping, and `git diff --check` is clean. Captured final OpenAI Responses and Anthropic OAuth provider payloads with network dispatch stopped at `onPayload`; instruction/tool/cache-key fingerprints stayed stable between initial and evidence requests. Live reviewer decisions, latency, and UI wording still need verification after `/reload`.
