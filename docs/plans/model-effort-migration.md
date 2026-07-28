# Shared model effort migration

Migrate extension-owned model selection to `packages/agent/shared/model-effort.ts` after commit proves the policy. Move each extension's ordered model and thinking-level preferences into the shared tiers, keep workload classification near the extension, and remove replaced local model lists.

Current migration candidates: auto-name, handoff, Q&A, review, isolated sessions used by subagents, and any later extension that selects a model for nested generation.
