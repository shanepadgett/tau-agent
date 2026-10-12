# Disabled compaction mode

## Agreed behavior

`extensions.compaction.selfCompact.enabled: false` disables the entire Tau compaction implementation. Pi owns manual, automatic, and recovery compaction, including summary generation and recent-token retention. The footer continues showing context usage.

## Implementation

- The compaction entry point reads trusted, merged Tau settings on the first `session_start` of each extension runtime.
- Disabled mode registers no tool, prompt source, compaction override, tool lock, handoff routing, continuation, or recovery handler. Persisted handoff entries remain on disk but are not restored or executed.
- Enabled mode registers the existing implementation with those settings and initializes its branch state explicitly. Subsequent session changes use the existing restoration handlers.
- Settings changes take effect at startup or `/reload`. Pi 1.1.0 supports registering tools after startup but has no tool-unregister API; reload replaces the runtime and its registered tools.
- Preserve the footer implementation. Without compaction events it already reads context usage directly and displays its ordinary context-window bar.
- Update the extension README and Tau help with disabled-mode behavior and the reload requirement.

## Boundaries and cache safety

`session_start → loadTauExtensionSettings(ctx, settingsSpec) → enabled ? registerSelfCompaction(pi, ctx, settings) : return`.

Within a runtime, registration and settings stay fixed. Disabled mode adds no tool declaration, prompt section, or trailing guidance. Reloading from enabled mode necessarily changes the tool set and current context-management instructions once; historical transcript entries remain immutable. Consecutive requests after that transition must keep identical tool declarations and instructions when no other inputs change.

## Verification

Use temporary, untracked runtime probes to check disabled registration, persisted pending state, native compaction pass-through, enabled registration, and initialization. Inspect the final provider request for absent `self_compact` declarations and instructions in disabled mode. Do not add or modify tests. Run repository checks at completion. Interactive verification requires user `/reload`.

## Implementation result

Implemented registration at the startup boundary and removed runtime enabled checks from the enabled-only implementation. The footer code is unchanged.

SDK probes using the production compaction and Soul extensions against a temporary local OpenAI-compatible endpoint verified:

- Disabled mode has no registered or declared `self_compact` tool and no context-management instructions.
- A persisted failed handoff causes no lock, retry, or extra turn while disabled.
- Native manual compaction retains recent messages and writes no Tau retention anchor.
- Enabled mode registers and activates the tool before the first provider request.
- Enabled-to-disabled `/reload` removes the tool and instructions. Consecutive serialized provider requests then keep identical instructions and tool declarations.
- Trusted project settings override global enablement in both directions.

Temporary probe resources were removed. No tests were added or changed. Interactive footer and scrollback verification remains for the user after `/reload`.
