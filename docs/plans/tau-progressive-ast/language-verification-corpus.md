# AST Language Verification Corpus

Status: active

Use this corpus for manual acceptance checks whenever a change affects language adapters, outlines, locators, signatures, documentation attachment, declaration ranges, or parser recovery. Reference repositories live under `~/.local/share/tau-agent/references/`. Verify each working tree is clean before testing. Mutation phases may edit these fixtures during acceptance, but must run `git reset --hard HEAD` afterward and verify every working tree is clean again.

This corpus is mandatory for every phase in this plan. Before a phase is complete, run its applicable acceptance workflow against all nine reference repositories and the Markdown fixture below. Unit tests and phase-specific fixtures do not replace this pass. A failure in any supported language blocks phase completion.

## Required probes

| Adapter | Reference repository | Production source | Declaration | Expected documentation |
| --- | --- | --- | --- | --- |
| TypeScript | `~/.local/share/tau-agent/references/pi` | `packages/agent/src/agent.ts` | `AgentOptions` | `Options for constructing an {@link Agent}.` |
| TSX | `~/.local/share/tau-agent/references/excalidraw` | `packages/excalidraw/components/Button.tsx` | `Button` | `A generic button component that follows Excalidraw's design system.` |
| Rust | `~/.local/share/tau-agent/references/ast-bro` | `src/adapters/sql.rs` | `parse_sql` | `Parse a SQL source.` |
| C# | `~/.local/share/tau-agent/references/Avalonia` | `src/Avalonia.Base/Animation/Animatable.cs` | `Transitions` | `Gets or sets the property transitions for the control.` |
| Go | `~/.local/share/tau-agent/references/go-tui` | `app.go` | `NewApp` | `creates a new application with the terminal set up for TUI usage.` |
| Java | `~/.local/share/tau-agent/references/guava` | `android/guava/src/com/google/common/base/Preconditions.java` | `checkArgument(boolean expression)` | `Ensures the truth of an expression` |
| Odin | `~/.local/share/tau-agent/references/Odin` | `base/runtime/core_builtin.odin` | `copy_slice` | `copies elements from a source slice` |
| Kotlin | `~/.local/share/tau-agent/references/okio` | `okio/src/commonMain/kotlin/okio/FileSystem.kt` | `canonicalize` | `Resolves [path] against the current working directory` |
| Swift | `~/.local/share/tau-agent/references/swift-collections` | `Sources/BasicContainers/RigidArray/RigidArray.swift` | `RigidArray` beginning near line 49 | `A fixed capacity, heap allocated, noncopyable array` |

Markdown keeps its heading-and-section declaration model. Use `packages/agent/native/tau-ast/fixtures/markdown.md`; code-style documentation attachment does not apply.

## Verification procedure

Exercise the phase-specific workflow in every reference repository. When a phase affects declaration extraction or symbol retrieval, also perform these checks for every code-language adapter:

1. Run a default outline with `includeDocs` omitted and locate the declaration above.
2. Retrieve `signatureWithDocs` from that locator. Confirm the expected phrase is present and no implementation body appears.
3. Run an outline with `includeDocs: true`, then retrieve `signature`. Confirm documentation is absent while attributes, annotations, modifiers, generics, and multiline formatting remain.
4. Retrieve `declaration` and confirm the exact declaration still includes its body and attached source comments.
5. Check an unattached nearby comment when documentation association changed. The comment must stay excluded and the documented-signature result must include a diagnostic.

Java, Odin, and current Swift language features may produce parser-recovery diagnostics in these repositories. The selected declaration must still resolve through the same locator and return the expected documented contract. Treat new or wider recovery as a separate regression signal.
