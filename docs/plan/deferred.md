# Deferred

Decisions to make later. Each line is the question and what brings it up. When that happens, move the item to Open in README.md.

- OpenTelemetry tracing for enterprises. Comes up when enterprise tracing is requested.
- How npm delivers the binary: a launcher plus one package per platform, or the npm package holds only SDK types and the binary installs separately. Comes up at build step 6.
- Whether a separate raw shell tool beats a shell function inside the sandbox. Comes up once the agent loop runs.
- Custom type-aware lint rules. Comes up when TypeScript 7.1 ships its JS API.
- Whether a generated module map would improve helper discovery. Comes up when reuse-first planning misses an existing helper.
- Whether to carry FFF's native tie-break patch. Comes up if a ranking bug is opened after trying unpatched FFF; prefer an upstream fix over maintaining native binaries.
- web-tree-sitter or `@ast-grep` for code-structure tools. Comes up when those tools are ported.
- Crash risk: a tool can succeed and the process die before its result is saved, so a rebuild could rerun it. Recording a tool-started entry would show the crash as an interrupted tool. Comes up at build step 2, since it bears on "no background task recovery".
- One SQLite database file per session, or one shared file. Comes up at build step 3.
