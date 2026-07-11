---
description: Compress prose while preserving meaning
argument-hint: "<target>"
---

Cavemanify $ARGUMENTS.

Compress prose. Preserve meaning.

Target is required. If missing, ask for target.

If target is file or directory, edit in place. If target is pasted text, return rewritten text in chat.

Rules:

- Drop filler, hedging, pleasantries, throat clearing, repeated examples.
- Keep technical terms, paths, commands, APIs, flags, regexes, constraints, quoted errors exact.
- Keep code blocks unchanged unless user explicitly asks to rewrite code.
- Keep decision logic and branching conditions.
- Keep frontmatter keys. Rewrite values only when meaning stays same.
- Long sentence -> short sentence or fragment.
- Paragraphs -> bullets when clearer.
- If editing scripts, change comments only unless user asks for code changes.

After file edits, report changed paths only.
