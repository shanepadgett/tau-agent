# Live prove — reference corpus (mandatory)

Every task that registers or changes a **live tool** (or a language adapter that a live tool already exposes) must prove it with the **real harness tool** after `/reload`. Not a bun one-off. Not a new unit test. Not “IR dump only” when a tool already exists.

## Corpus root

```text
~/.local/share/tau-agent/references/
```

Absolute on this machine: `/Users/shanepadgett/.local/share/tau-agent/references/`.

Read-only. Do not modify reference checkouts.

## Required repositories (language coverage)

| Repo | Primary languages | Why it is here |
| --- | --- | --- |
| `pi` | TypeScript | Real package layout, exports/`dist`→`src`, agent-scale TS |
| `excalidraw` | TypeScript / TSX | Large TS/TSX app monorepo |
| `go-tui` | Go | Idiomatic exported Go API |
| `ast-bro` | Rust | Structural/tooling Rust |
| `Avalonia` | C# | Large C# UI framework tree |
| `guava` | Java | Classic public Java packages |
| `okio` | Kotlin (and Java) | Multiplatform Kotlin sources |
| `swift-collections` | Swift | Package-style Swift modules |
| `Odin` | Odin | `core/` library prose + procs |

Use **narrow scopes** under these trees (one package/module directory). Do not scan a whole mega-repo root unless the task is specifically about budgets/limits.

## How to prove

1. `/reload` after extension changes.
2. Call the **registered tool name** from the agent harness (`outline`, `show`, `discover`, …) with absolute paths into the corpus (or cwd set such that those paths resolve).
3. Cover **every language the task claims**. Per language coverage law (COLD-START): user-facing tools that can work on a corpus language must be proved on that language — not TS-only with a single non-TS capability-error poke. Genuine concept exceptions (e.g. Markdown file deps) are the only skip.
4. Exercise the task’s **Done when** cases on corpus paths first; use this monorepo only as an extra TS convenience, not the sole proof.
5. Record failures that are product bugs (fix them) vs corpus quirks (note once, move on).

## Suggested narrow scopes

| Repo | Example scope |
| --- | --- |
| `pi` | `.../pi/packages/coding-agent/src/core` |
| `excalidraw` | `.../excalidraw/packages/common/src` |
| `go-tui` | `.../go-tui` (repo root is small) |
| `ast-bro` | `.../ast-bro/src` |
| `Avalonia` | `.../Avalonia/src/Avalonia.Base` |
| `guava` | `.../guava/guava/src/com/google/common/base` |
| `okio` | `.../okio/okio/src/commonMain/kotlin/okio` |
| `swift-collections` | `.../swift-collections/Sources/DequeModule` |
| `Odin` | `.../Odin/core/bufio` |

## Task README contract

Each remaining task’s **Done when** must either:

- point at this file and list which corpus repos/languages apply, or
- inline the same rule: harness tool + these references + languages touched.

Cold-start and the plan index link here so a fresh window cannot “forget” the corpus.
