# Patch Tool Guidance

## Problem

Agents miss simple markdown edits because patch examples make it easy to remove the literal list marker from matched lines.

Bad pattern seen:

```diff
- Do not add optional properties...
+ Do not add optional properties...
```

For a markdown bullet, the matched file line is `- Do not...`, so the patch removal line must include both the patch marker and the file text:

```diff
-- Do not add optional properties...
+- Do not add optional properties...
```

Same for adding bullets: `+- New bullet`, not `+ New bullet`.

## Plan

- Update patch guidance and examples to call out patch marker vs file content marker explicitly.
- Add a markdown bullet example using `-- old bullet` and `+- new bullet`.
- Clarify `@@` anchors: not required for a unique replacement, required for pure insertions and useful for repeated/ambiguous context.
- Mention the bad `@@ - No ...` form: anchors must be real existing file lines, not diff hunks.
- Check the `crumbs` repository for why that patch tool works better and why agents rarely miss this there.

## Acceptance

- Agent can correctly split one markdown bullet into two bullets with one patch.
- Guidance explains why the extra `-` is part of file content, not patch syntax.
