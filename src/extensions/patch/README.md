# patch

Replaces the built-in `edit` and `write` tools with one multi-file patch tool. The agent applies structured patches to create, edit, move, and delete files while this extension is active.

## What it does

Registers a `patch` tool that accepts a Codex-style patch body: one envelope, one or more file sections. It supports new files, full rewrites, contextual edits, renames, and deletions. Tau also supports `*** Replace File:` for explicit full-file replacement.

Malformed patch envelopes fail without changing files. Section-level failures — parse errors, duplicate paths, missing files, match failures, and existing move targets — fail those sections while independent valid sections still apply.

## How to use

The model calls `patch` automatically when it needs to change files. Patch marker lines may have leading/trailing whitespace.

```text
*** Begin Patch
*** Add File: path/to/new.ts
+file content here
*** Replace File: path/to/existing-full-rewrite.ts
+full replacement content here
*** Update File: path/to/existing.ts
 context line
-old line
+new line
*** Update File: path/to/old-location.ts
*** Move to: path/to/new-location.ts
 const handler = () => {}
-module.exports = handler;
+export default handler;
*** Delete File: path/to/remove.ts
*** End Patch
```

- **Add File** — writes whole-file content. Only `+` lines become file content. May overwrite existing files.
- **Replace File** — writes whole-file content and reports as a replacement. Only `+` lines become file content.
- **Update File** — edits existing files with context, removal, and addition lines. Unanchored repeated matches use the first forward match. A pure `+` hunk appends to EOF; include context body lines for positional inserts.
- **Move to** — appears immediately after an Update File header. The target must not already exist.
- **Delete File** — removes an existing file.

If an update match fails, reread the current file and retry with corrected context.
