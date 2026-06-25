# patch

Replaces the built-in `edit` and `write` tools with a single multi-file patch tool. The agent applies structured patches to create, edit, move, and delete files — no other file-mutation path is available while this extension is active.

## What it does

Registers a `patch` tool that accepts a Codex-style patch body and applies file changes in one call: new files, full rewrites, contextual edits, renames, and deletions. Disables `edit` and `write` so the model uses `patch` exclusively.

Malformed patch envelopes fail without changing files. Section-level failures — parse errors, duplicate paths, missing files, match failures, no-ops, and existing move targets — fail those sections while independent valid sections still apply.

## Why

One coherent patch per task produces fewer round-trips and cleaner diffs than scattered edit/write calls. The patch grammar gives the model precise control over context-sensitive edits without the ambiguity of search-and-replace.

## How to use

The model calls `patch` automatically when it needs to change files — no user invocation needed. The patch grammar:

```
*** Begin Patch
*** Add File: path/to/new.ts
+file content here
*** Replace File: path/to/existing-full-rewrite.ts
+full replacement content here
*** Update File: path/to/existing.ts
@@ function heading
 context line
-old line
+new line
*** Update File: path/to/old-location.ts
*** Move to: path/to/new-location.ts
-old content
+new content
*** Delete File: path/to/remove.ts
*** End Patch
```

- **Add File** — writes whole-file content, usually for new files. May overwrite existing files when that is the intended edit. Only `+` lines become file content.
- **Replace File** — writes whole-file content, usually for full rewrites of existing files. Same apply behavior as Add File, but renders as a replacement.
- **Update File** — contextual edits via context/removal/addition lines. Use `@@` anchors when context may repeat. `@@` positions the edit after the anchor line; do not repeat the anchor as a removed/context line. Pure insertions must use `@@` or `*** End of File`.
- **Delete File** — removes files.

EOF append accepts either order:

```
*** Update File: file.ts
*** End of File
+export default app;
```

or:

```
*** Update File: file.ts
+export default app;
*** End of File
```

Patch input must start with exactly `*** Begin Patch` and end with exactly `*** End Patch`.
