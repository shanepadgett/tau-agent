# Ready

Adds `/ready` to scan the repository for agent-readiness rails and write one report file.

You pick Markdown or HTML. Tau runs a deterministic scan (no model), builds the report in memory, and writes a timestamped file under `.pi/tau/ready/` using your local timezone in the filename. A notification shows the path and status counts.

The scan looks for cold-start docs, toolchain pins, task/verify entrypoints, silent command runner config, policy and vocabulary files, standards and context catalogs, and language-specific format/lint/types/entropy tools (TypeScript, Deno, Go, Rust packs in v1). Statuses are pass, weak, missing, n/a, or unknown — no scores.
