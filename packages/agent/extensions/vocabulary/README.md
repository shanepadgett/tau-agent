# Vocabulary

Vocabulary gives the agent consistent product terms for a repository. Terms and short definitions live in `.pi/tau/vocabulary.json` at the project root. Only term names and brief tool-discovery guidance appear automatically in the prompt; definitions are available through the deferred tool. Missing or empty vocabulary adds no section.

Ask the agent to look up or manage vocabulary. It loads the deferred `vocabulary` tool through `tool_search` and can list, read, create, update, or delete terms. Updates can rename a term and replace its definition.

Before saving a change, the agent must discuss the product concept and its definition with you and reach explicit agreement. Vocabulary is not collected automatically and should not include code symbols, file names, or implementation details. Agreement happens in conversation, without a confirmation dialog.

You can also edit the file directly:

```json
{
  "terms": [
    {
      "term": "Agent run",
      "definition": "All agent work caused by one user prompt, until the agent is done."
    }
  ]
}
```

Term lookup is case-insensitive. Empty definitions, duplicate terms, and invalid documents are rejected. Term names appear alphabetically. File formatting, entry order, and definition-only changes do not change the prompt. Changes to term names refresh the prompt section at the next agent run. Cache behavior for updates and deferred-tool loading depends on the provider.

Run `/reload` after installing or changing this extension.
