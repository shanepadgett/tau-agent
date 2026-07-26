# System

## Purpose

- Give agents filesystem exploration, structural source orientation, exact source retrieval, and locator-scoped edits.
- Prefer compact model payloads over dumping whole files when structure answers the question.
- For configured supported source, force a current structural attempt before ordinary `read`.
- Keep scans bounded, deterministic, ignore-aware where applicable, and cancellable.

## Supported structural languages

- TypeScript (`.ts`)
- TSX (`.tsx`)
- Odin (`.odin`)
- Go (`.go`)
- Rust (`.rs`)
- C# (`.cs`)
- Java (`.java`)
- Kotlin (`.kt`, `.ktm`, `.kts`)
- Swift (`.swift`)
- Markdown (`.md`, `.markdown`, `.mdown`)

## Platform / worker availability

- Packaged AST worker is required for structural tools: `outline`, `symbol`, `api_discover`, `ast_search`, relationship tools, locator edits.
- Current packaged support target: Apple Silicon Mac (`darwin-arm64`).
- On unsupported hosts, non-AST Explore tools still work.
- On unsupported hosts or missing worker, structural tools fail with a clear platform/install error when invoked.
- Structural tools remain registered even when the worker is unavailable.

## Session lifecycle

- Session start: reset tool-row state, read snapshots, locator state, temporary output store; reload Explore settings.
- Session tree change: clear read snapshots; reset locator/orientation gate state as required for branch safety.
- Session compact: clear read snapshots (complete-file baseline may become unavailable).
- Session shutdown: clear locator/orientation state; shut down AST worker; shut down temporary output store.
- Successful Tau file mutations invalidate structural state for changed paths (locators stale; orientation patch fingerprints recorded when provided).

## Agent workflow expectations (product intent)

- Identify the job first: locate, reuse, edit, explain, or debug.
- Use the cheapest useful structural step before loading bodies, callers, tests, or docs needed only later.
- Stop when the current question is answered; expand only for a specific unresolved question.
- Prefer locator edits when a complete declaration/body/section is the natural boundary.
- Prefer textual patching when the change crosses structural boundaries or depends on surrounding text.

## Commands

- `/read-stats` — session estimated token/cost savings from read caching and orientation (TUI mode).
