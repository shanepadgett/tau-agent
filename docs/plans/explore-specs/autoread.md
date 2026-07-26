# Autoread

## Purpose

- Establish complete-file knowledge in active context for selected paths without the agent manually calling `read`, when the harness/extension injects autoread messages.
- Feed the same complete-file trust/cache machinery used by later `read` unchanged/diff behavior.

## Behavior

- Autoread loads file bytes under size limits and produces a displayable custom message with complete-file metadata.
- Successful autoread registers complete-file knowledge while that source remains in active context.
- Later `read` of the same complete file can return unchanged markers or diffs against that baseline when still trusted.
- If lifecycle is no longer current mid-flight, autoread must not commit stale knowledge.
- Failures are represented as autoread status/error details rather than silently inventing contents.

## Interaction with read gate

- Autoread is a knowledge injection path; it does not replace the requirement that gated manual `read` needs a structural attempt, except where product explicitly treats trusted complete-file chains as already known content in context.
- After compaction/removal from context, complete-file trust may end; recovery rules in `read` apply.

## Non-goals

- Not a general always-on full-repo ingest
- Not a bypass to dump gated files into the model without session/product controls
