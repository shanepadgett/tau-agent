# Vocabulary

Vocabulary gives the agent consistent product terms for a repository. Terms and short definitions live in `.pi/tau/vocabulary.json` at the project root and appear automatically in a dedicated prompt section. Missing or empty vocabulary adds no section.

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

Term lookup is case-insensitive. Empty definitions, duplicate terms, and invalid documents are rejected. Terms appear alphabetically, and file formatting or entry order does not change the prompt. Saved changes refresh the prompt section at the next agent run; unchanged vocabulary preserves the existing cached instructions. Cache behavior for updates and deferred-tool loading depends on the provider.

Run `/reload` after installing or changing this extension.
