# Deferred

Decisions to make later. Each line is the question and what brings it up. When that happens, move the item to [questions.md](questions.md).

- OpenTelemetry tracing for enterprises. Comes up when enterprise tracing is requested.
- How npm delivers the binary: a launcher plus one package per platform, or the npm package holds only SDK types and the binary installs separately. Comes up at build step 8.
- Whether a separate raw shell tool beats a shell function inside the sandbox. Comes up once the agent loop runs.
- OS-level confinement for commands that `run` starts: Seatbelt (`sandbox-exec`) on macOS, Landlock or bubblewrap on Linux, as Codex CLI and Claude Code do, limiting writes to the workspace and network to an allowlist. Could be a replaceable SDK part with the OS sandbox as Tau's default. Comes up at build step 4.
- Whether Tau runs well inside NVIDIA OpenShell (a container sandbox with a gateway and credential injection) for users who want that containment. OpenShell is not Tau's runtime: it wraps the whole agent, needs a container runtime and a gateway service, and keeps credentials outside the agent. Comes up when a user runs Tau inside it, or at build step 8.
- Prompt cache mechanics: where each provider takes cache markers, building the compaction request from the same system prompt, functions and history with only the summary instruction appended (OpenCode PRs #25100 and #42506 estimate about 90% savings), and showing the cache hit rate in the sidebar. Comes up at build step 5.
- Custom type-aware lint rules. Comes up when TypeScript 7.1 ships its JS API.
- A versioned source for TypeScript 7 compiler-option docs. Comes up when an agent misconfigures `tsconfig.json` from the README alone, or when the TypeScript website documents 7.x.
- Whether a generated module map would improve helper discovery. Comes up when reuse-first planning misses an existing helper.
- Whether to carry FFF's native tie-break patch. Comes up if a ranking bug is opened after trying unpatched FFF; prefer an upstream fix over maintaining native binaries.
- web-tree-sitter or `@ast-grep` for code-structure tools. Comes up when those tools are rebuilt.
- Crash risk: a tool can succeed and the process die before its result is saved, so a rebuild could rerun it. Recording a tool-started entry would show the crash as an interrupted tool. Comes up at build step 4, since it bears on "no background task recovery".
- One SQLite database file per session, or one shared file. Comes up at build step 3.
- How branching works: what a branch point is, how the user moves between branches and sees the tree, and what Pi's design makes hard to understand. Comes up at build step 3.
- OS keychain storage, encryption at rest, several accounts per provider, or per-project credentials. Comes up when a user or enterprise asks for one.
- Whether Fallow follows dynamically loaded default exports. Comes up when the extension host loads modules by path.
- The exact 49/50-token duplicate thresholds. Comes up when a duplicate report looks wrong near the threshold.
- Whether development hooks rerun checks after a live session's files change. Comes up when a hook misses a change in a live session.
- The Codex `session_id` header and priority tier. Comes up at build step 3, when sessions supply the conversation ID.
- Parsing a `provider/model` string. Comes up with the first caller that takes a model name from the user.
- ChatGPT plan usage-limit errors, with a link to the usage settings. Comes up at build step 4, when the turn loop handles errors.
- Refreshing OAuth tokens in the background before a request needs them. Comes up if a refresh noticeably delays a request.
- A live token refresh on the `chatgpt` route through Tau's code (offline tests cover it). Comes up at the next live check.
- Whether Tau reloads `~/.tau/settings.json` when it changes, or only on start. Comes up at build step 7, with extension hot reload.
