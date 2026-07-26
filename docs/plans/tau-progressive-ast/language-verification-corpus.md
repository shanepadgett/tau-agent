# AST Language Verification Corpus

Status: active

Use this corpus for manual acceptance checks whenever a change affects language adapters, outlines, locators, signatures, documentation attachment, declaration ranges, or parser recovery. Reference repositories live under `~/.local/share/tau-agent/references/` and remain read-only.

## Required probes

| Adapter | Repository | Production source | Declaration | Expected documentation |
| --- | --- | --- | --- | --- |
| TypeScript | `pi` | `packages/agent/src/agent.ts` | `AgentOptions` | `Options for constructing an {@link Agent}.` |
| TSX | `excalidraw` | `packages/excalidraw/components/Button.tsx` | `Button` | `A generic button component that follows Excalidraw's design system.` |
| Rust | `ast-bro` | `src/adapters/sql.rs` | `parse_sql` | `Parse a SQL source.` |
| C# | `Avalonia` | `src/Avalonia.Base/Animation/Animatable.cs` | `Transitions` | `Gets or sets the property transitions for the control.` |
| Go | `go-tui` | `app.go` | `NewApp` | `creates a new application with the terminal set up for TUI usage.` |
| Java | `guava` | `android/guava/src/com/google/common/base/Preconditions.java` | `checkArgument(boolean expression)` | `Ensures the truth of an expression` |
| Odin | `Odin` | `base/runtime/core_builtin.odin` | `copy_slice` | `copies elements from a source slice` |
| Kotlin | `okio` | `okio/src/commonMain/kotlin/okio/FileSystem.kt` | `canonicalize` | `Resolves [path] against the current working directory` |
| Swift | `swift-collections` | `Sources/BasicContainers/RigidArray/RigidArray.swift` | `RigidArray` beginning near line 49 | `A fixed capacity, heap allocated, noncopyable array` |

Markdown keeps its heading-and-section declaration model. Use `packages/agent/native/tau-ast/fixtures/markdown.md`; code-style documentation attachment does not apply.

## Verification procedure

For every affected code-language adapter:

1. Run a default outline with `includeDocs` omitted and locate the declaration above.
2. Retrieve `signatureWithDocs` from that locator. Confirm the expected phrase is present and no implementation body appears.
3. Run an outline with `includeDocs: true`, then retrieve `signature`. Confirm documentation is absent while attributes, annotations, modifiers, generics, and multiline formatting remain.
4. Retrieve `declaration` and confirm the exact declaration still includes its body and attached source comments.
5. Check an unattached nearby comment when documentation association changed. The comment must stay excluded and the documented-signature result must include a diagnostic.

Java, Odin, and current Swift language features may produce parser-recovery diagnostics in these repositories. The selected declaration must still resolve through the same locator and return the expected documented contract. Treat new or wider recovery as a separate regression signal.
