# Vocabulary extension

## Agreed behavior

- Store repository product terms in `<repo>/.pi/tau/vocabulary.json`.
- Inject only registered noun names and the brief discovery/agreement sentence into a dedicated `vocabulary` section through Soul. Keep definitions in JSON and deferred tool results, not in the prompt.
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

`before_agent_start` → Soul → vocabulary source → validated JSON → alphabetically sorted noun names. Empty vocabulary contributes no section. Metadata, JSON order, and definition-only changes cannot change rendered content. Reads run each agent run; changes to noun names become prompt-section updates on the next run.

Unchanged sections must produce no transcript patch, including when only definitions change. Noun-name edits must change only the vocabulary section; Pi appends the delta on supported providers and projects current instructions into the leading prompt where required. Verify provider serialization as well as section rendering, including compaction and resume behavior. Loading the deferred tool follows Pi's existing provider-specific cache policy.

## Verification

Initial offline evaluation verified missing and malformed files, duplicate terms, cancellation before publication, project-root lookup, deterministic Soul section rendering, and unchanged rendering in fresh reload/compaction contexts. The original definition-inclusive rendering was corrected to noun names only. Live tool use requires the user's `/reload`.

After correction, offline evaluation verified that Soul and final OpenAI payloads exclude definitions, including the leading-instruction fallback. Definition-only edits and reordered entries produce no prompt patch. Renames update only the vocabulary section and preserve the previous serialized input prefix on supported providers. Fresh reload/compaction contexts and replayed resume state remain stable. Definitions remain in JSON. No live tool calls or network requests were made.
