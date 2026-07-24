# Explore

Explore is Tau's first-party filesystem exploration extension.

It exists so agents can inspect paths, discover files, search text, inspect declarations in supported source languages, and read exact source with compact model payloads and readable tool rows. Autoread establishes complete-file knowledge while that source remains in active context. Later reads can return an unchanged marker or a smaller diff instead of resending the file.

When the source baseline is no longer available, such as after compaction or a cold subagent resume, `read` safely returns the current full source.

Agents invoke it with `ls`, `find`, `grep`, `outline`, `symbol`, and `read`. `outline` returns public declaration signatures and parenthesized numeric locators for TypeScript, TSX, Odin, Go, Rust, C#, Java, Kotlin, and Swift files. It also accepts a package directory, which inspects supported files directly inside it. Exact-name filters narrow the result, while `includePrivate` exposes internal declarations. `symbol` accepts those numbers to retrieve several exact declarations in one call, can add bounded surrounding lines, and rejects the whole batch when any locator is stale. Users run `/read-stats` to see estimated token and cost savings for the session.

Installed packages support `outline` and `symbol` on Apple Silicon Macs. They include the worker, so users do not need Rust or Cargo. On other platforms, the rest of Explore remains available and AST tools report the platform limit when invoked.

Use the cheapest useful step:

1. Outline a package directory to discover its public API.
2. Add exact names when likely declarations are known.
3. Set `includePrivate` when implementation work needs internals.
4. Send several locators to `symbol` for complete declarations.
5. Add context lines when the edit needs nearby source.
6. Use ranged or whole-file `read` for cross-cutting logic, exact formatting, or parser gaps.
