# Working Memory

Working Memory keeps the model focused on current task evidence while raw session history stays intact.

It nudges the agent to search first, then read relevant repo-owned work files as whole files. Partial reads still exist for huge files, dependencies, generated/vendor files, and external docs.

After successful mutations, Working Memory adds current evidence before later reasoning:

- `reread <path>` for relevant changed files, with full current file content
- `path update` for creates, moves, deletes, and skipped rereads such as ignored, excluded, dependency, or too-large files

Use `forget` when exploration turns out irrelevant. Keep one short checkpoint and, for forgotten paths, include a concrete “only reread if ...” condition.

Reload Tau after changing extension code before testing it.
