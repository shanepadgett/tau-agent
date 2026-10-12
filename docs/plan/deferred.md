# Deferred

Decisions to make later. Each line is the question and what brings it up. When that happens, move the item to Open in README.md.

- OpenTelemetry tracing for enterprises. Comes up when enterprise tracing is requested.
- How npm delivers the binary: a launcher plus one package per platform, or the npm package holds only SDK types and the binary installs separately. Comes up at build step 8.
- Whether a separate raw shell tool beats a shell function inside the sandbox. Comes up once the agent loop runs.
- Custom type-aware lint rules. Comes up when TypeScript 7.1 ships its JS API.
- A versioned source for TypeScript 7 compiler-option docs. Comes up when an agent misconfigures `tsconfig.json` from the README alone, or when the TypeScript website documents 7.x.
- Whether a generated module map would improve helper discovery. Comes up when reuse-first planning misses an existing helper.
- Whether to carry FFF's native tie-break patch. Comes up if a ranking bug is opened after trying unpatched FFF; prefer an upstream fix over maintaining native binaries.
- web-tree-sitter or `@ast-grep` for code-structure tools. Comes up when those tools are rebuilt.
- Crash risk: a tool can succeed and the process die before its result is saved, so a rebuild could rerun it. Recording a tool-started entry would show the crash as an interrupted tool. Comes up at build step 4, since it bears on "no background task recovery".
- One SQLite database file per session, or one shared file. Comes up at build step 3.
- OS keychain storage, encryption at rest, several accounts per provider, or per-project credentials. Comes up when a user or enterprise asks for one.
- Whether Fallow follows dynamically loaded default exports. Comes up when the extension host loads modules by path.
- The exact 49/50-token duplicate thresholds. Comes up when a duplicate report looks wrong near the threshold.
- Whether development hooks rerun checks after a live session's files change. Comes up when a hook misses a change in a live session.
