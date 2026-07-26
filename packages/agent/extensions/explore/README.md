# Explore

Explore is Tau's first-party filesystem exploration extension.

It exists so agents can inspect paths, discover files, search text, inspect declarations in supported source languages, and read exact source with compact model payloads and readable tool rows. Autoread establishes complete-file knowledge while that source remains in active context. Later reads can return an unchanged marker or a smaller diff instead of resending the file.

When the source baseline is no longer available, such as after compaction or a cold subagent resume, `read` safely returns the current full source.

Agents invoke it with `ls`, `find`, `grep`, `outline`, `symbol`, and `read`. `outline` returns public declaration signatures and parenthesized numeric locators for TypeScript, TSX, Odin, Go, Rust, C#, Java, Kotlin, Swift, and Markdown files. Markdown headings locate their complete sections. It accepts a package directory for one-level inspection, or `recursive: true` for ignore-aware mixed-language orientation of a repository or subtree. Recursive output stays bounded; when the complete outline is larger, Tau saves it to a temporary path for targeted `grep` and ranged `read` during the active session. Exact-name filters narrow the result, `includePrivate` exposes internal declarations, and `includeDocs` adds attached documentation comments when they are needed. Annotations and attributes remain in normal outlines. `symbol` accepts those numbers to retrieve several exact declarations in one call, can add bounded surrounding lines, and rejects the whole batch when any locator is stale. Users run `/read-stats` to see estimated token and cost savings for the session.

Explore scans a bounded, ignore-aware slice of the working root before each agent run. When the repository contains supported source and the selected native worker is usable, Explore adds language-specific AST-first guidance to the agent prompt. Unsupported repositories and hosts get the ordinary filesystem workflow. `outline` and `symbol` stay registered either way.

Installed packages support `outline` and `symbol` on Apple Silicon Macs. They include the worker, so users do not need Rust or Cargo. On other platforms, the rest of Explore remains available and AST tools report the platform limit when invoked.

For supported source, use the cheapest useful step:

1. Use a recursive outline to orient an unfamiliar repository or subtree.
2. Outline a package directory to inspect its immediate public API.
3. Add exact names when likely declarations are known.
4. Set `includePrivate` when implementation work needs internals.
5. Set `includeDocs` when declaration documentation affects the task.
6. Send several locators to `symbol` for complete declarations.
7. Add context lines when the edit needs nearby source.
8. Use `read` for unsupported files, cross-cutting logic, exact formatting, parser gaps, or source outside declaration boundaries.
