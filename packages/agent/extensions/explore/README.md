# Explore

Explore is Tau's first-party filesystem exploration extension.

It exists so agents can inspect paths, discover files, search text, inspect declarations in supported source languages, and read exact source with compact model payloads and readable tool rows. Autoread establishes complete-file knowledge while that source remains in active context. Later reads can return an unchanged marker or a smaller diff instead of resending the file.

When the source baseline is no longer available, such as after compaction or a cold subagent resume, `read` safely returns the current full source.

Agents invoke it with `ls`, `find`, `grep`, `outline`, `symbol`, and `read`. `outline` returns declaration signatures and short locators for TypeScript, TSX, Odin, Go, Rust, C#, Java, Kotlin, and Swift files. `symbol` returns the exact declaration source and rejects locators after the file changes. Users run `/read-stats` to see estimated token and cost savings for the session.
