# Standardized repository check reports

Status: architecture approved. Silent Command Runner must remain generic. Tool-specific adapters belong to this repository, not the shipped extension. User-facing documentation must recommend repository-local reporting scripts to save tokens while preserving actionable failures.

## Ownership

Add a repository check-reporting system under root `scripts/check-reporting/`. Mise tasks invoke its CLI, which executes native tools, captures their outputs, and normalizes failures. Tool schemas, output flags, formatter distinctions, assertion differences, and noise removal belong here. Another repository can use completely different producers without changes to Silent Command Runner.

Modify Silent Command Runner only to consume a tool-independent versioned report, validate it, apply aggregate output bounds, own session-scoped raw logs/overflow, and continue failed runs. Do not add Oxlint, Oxfmt, Vitest, Fallow, TypeScript, Mise, or schema adapter IDs to extension settings or implementation.

```text
mise check task
  -> repository reporting CLI
  -> native tool with appropriate output mode
  -> repository adapter normalizes complete output
  -> generic report-v1 envelope + native exit status
  -> Silent Command Runner validates envelope
  -> bounded complete failure blocks + session-scoped full logs
  -> agent continuation
```

## Generic producer/consumer contract

```ts
type CheckReportV1 = {
  version: 1;
  exitCode: number;
  blocks: string[]; // complete actionable diagnostics, already formatted by the producer
  raw: { stdout: string; stderr: string };
};
```

Use explicit generic `output: "text" | "report-v1"` selection per command. The normalized default is text for arbitrary existing commands. Report mode knows no tool names or native schemas. Validate every envelope field and check native exit status agreement; malformed reports and killed/empty failures remain failures with a bounded fallback. Preserve complete raw captures in Tau's shared session store. A valid report permits launcher noise to stay in the raw log rather than model content; exit disagreement still surfaces as an execution failure.

Bound the combined agent report through Tau's shared BoundedTextResultBuilder with complete-block retention. Retain whole diagnostics and omitted counts, including assertion differences and cause chains within their parent block. No per-stream tail truncation before report parsing, copied Pi output limits, or rewriting earlier conversation entries.

## Repository producers

| Check | Repository adapter input |
| --- | --- |
| check:fmt | Oxfmt --list-different; distinguish file-only layout differences from parsing/config/execution failures |
| check:lint | Oxlint JSON; preserve message, code, labels, related diagnostics, and help |
| check:types | tsc --pretty false; preserve diagnostic starts and meaningful continuation lines |
| test:unit | Repository-local Vitest reporter; preserve failure names, assertion differences, collection/setup/unhandled errors, and relevant causes |
| fallow:dead-code / fallow:dupes | Fallow JSON/quiet; normalize the installed version's findings and all clone locations |
| check:mise | Mise validation JSON; preserve task, category, message, and details |
| check:dependencies | Existing actionable dependency-installation failure message |
| check:schema | Recognized schema-drift message; other failures retain explicit fallback |

Installed investigation confirmed these CLI output modes. Vitest's agent reporter aliases MinimalReporter and inherits human failure rendering. Its JSON reporter does not directly serialize expected/actual fields needed for reliable assertion differences. Fallow 2.100.0 uses schema version 7, flattens dead-code findings into the root envelope, and reports duplication through clone_groups[].instances[].

Unknown producer output never disappears: include a short explicit fallback plus the full raw capture. Filtering is deterministic and adapter-specific, not an LLM summary or a global stderr filter. Markdown tooling stays separate.

## Next implementation slice

1. Ownership and generic envelope boundary agreed. README and Tau help now recommend repository-local check reporting to save tokens.
2. Implement and wire the generic consumer plus repository producer CLI together; avoid unreachable staging code.
3. Wire the nine existing Mise checks to repository adapters; keep post-write fixes silent.
4. Update documentation, generated settings schema, and repository source/tooling configuration for root scripts.
5. No new or modified suite tests, fixtures, or snapshots. User reload precedes live extension verification.

## Cache behavior

Stable command descriptions stay in append-only automatic-check instructions. Diagnostic blocks and temporary paths enter only new failure messages. Preserve the stable prefix of unchanged consecutive final serialized requests; never inject per-run report state into tool schemas or system content.

## Correction status

Removed the initial extension-specific adapter files and restored the partial settings/task migration. That placement was incorrect; the revised implementation starts from the generic runner and repository-local producers.
