# Vocabulary extension

## Agreed behavior

- Store repository product terms in `<repo>/.pi/tau/vocabulary.json`.
- Inject registered terms into a dedicated `vocabulary` section through Soul.
- Expose one deferred `vocabulary` tool with list, get, create, update, and delete operations.
- Discuss the product concept and exact definition with the user before saving any mutation. Agreement is conversational, not a confirmation dialog or a tool argument.
- Do not automatically collect nouns or register implementation details.

## Implementation

- `extensions/vocabulary/store.ts`: typed term schema, validated reads, project-root path, atomic saves with cancellation cleanup. Missing files represent an empty list; malformed files fail explicitly. Term identity is case-insensitive; presentation preserves spelling.
- `extensions/vocabulary/index.ts`: top-level object schema with operation-specific fields validated during execution (provider tool schemas require an object root); register the deferred group and `registerPromptSource({ key: "vocabulary/terms", section: "vocabulary", refresh: "append" })`.
- Tool mutations wrap the entire read-modify-write operation in Pi's `withFileMutationQueue`. Updates require an existing term and provide replacement spelling and definition; creates cannot overwrite.
- Tool text uses Tau's shared complete-block bounded-result handler and session-scoped overflow store. Session start and shutdown manage that store.
- Extension README and Tau help describe usage and the conversational agreement rule. No settings or new tests.

## Cache behavior

`before_agent_start` → Soul → vocabulary source → validated JSON → alphabetically sorted term lines. Empty vocabulary contributes no section. Metadata, JSON order, and whitespace outside definitions cannot change rendered content. Reads run each agent run; writes become prompt-section updates on the next run.

Unchanged sections must produce no transcript patch. Vocabulary edits must change only the vocabulary section; Pi appends the delta on supported providers and projects current instructions into the leading prompt where required. Verify provider serialization as well as section rendering, including compaction and resume behavior. Loading the deferred tool follows Pi's existing provider-specific cache policy.

## Verification

Offline evaluation verified missing and malformed files, duplicate terms, cancellation before publication, project-root lookup, deterministic Soul section rendering, and unchanged rendering in fresh reload/compaction contexts. OpenAI's final `onPayload` output retained the earlier input prefix after a vocabulary-only delta; its unsupported-mid-conversation fallback contained the latest definition in the leading instructions. Replayed section state produced no redundant update. No network requests or live vocabulary tool calls were made. Live tool use requires the user's `/reload`.
