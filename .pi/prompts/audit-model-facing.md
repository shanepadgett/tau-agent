---
description: Audit model-facing strings in one extension
argument-hint: "<extension-path>"
---

Audit every model-facing string from this extension:

```text
$1
```

Resolve `$1` to an extension root (directory with `index.ts` / entry, or a single `.ts` file). Relative paths: cwd first, then `packages/agent/extensions/<name>`, `.pi/extensions/<name>`. Ask once if missing or ambiguous.

## Goal

Show, in plain concrete text, **everything this extension can put in the model's context**. Reader should be able to skim the report and know exactly what the agent sees — tool schema text, system-prompt bits, injected messages, result/error strings — without opening source.

This is a read-only catalog. Do not edit code unless asked after the report.

## What counts

Any text that can reach the model via Pi/Tau surfaces this extension uses:

### System prompt / tool defs

- `before_agent_start` → `systemPrompt` (append or replace)
- `registerTool` / `defineTool`: `description`, parameter/property/enum schema descriptions, `promptSnippet`, `promptGuidelines`
- Built-in tool overrides (only fields the override sets; snippet/guidelines are not inherited)
- `resources_discover` skills: name + description always; full `SKILL.md` when loaded or `/skill:name`
- `resources_discover` prompt templates: body when `/name` expands into the user message

### Session / request

- `pi.sendMessage` `content` (LLM context; `display` is TUI-only)
- `before_agent_start` → injected `message`
- `pi.sendUserMessage`
- `context` event message rewrites/injections
- `before_provider_request` payload rewrites (final wire text, even if `getSystemPrompt()` differs)
- `message_end` message replacements
- Tau `injectFiles` / `prepareFileInjection` bodies

### Tool run / intercept

- `execute` return `content` (success and structured failure text)
- thrown errors (model-visible error text)
- `tool_result` patches to `content` / `isError`
- `tool_call` `{ block: true, reason }`
- Final tool result only — ignore pure TUI `onUpdate` partials unless they become final `content`

### Compaction / subagents

- `session_before_compact` summary
- `session_before_tree` summary
- Tau subagent def `description` + body; parent-visible subagent tool results; child task/files/prior-result injections this extension owns

### Easy to miss

- Tools registered later at runtime
- Strings built from settings, files, network, user/tool input then pushed through the surfaces above
- Helpers that only format model text — attribute at the call site that emits them

## What does not count

Unless also copied into a surface above:

- `appendEntry` / entry renderers, message/tool renderers, tool `details`, tool `label`
- Command descriptions, shortcuts, flags, UI notify/status/footer/widgets
- Settings schema text, README, comments, logs

## Method

1. Map entry + local modules this extension owns.
2. Search for the surfaces above.
3. For each hit, resolve the **exact text the model gets**, including runtime assembly (conditionals, detected runtimes, settings).
4. When text is dynamic, pick the **most complete realistic configuration** available in code (e.g. all optional runtimes on) and expand the final strings. If variants differ a lot, add a short second block for the important sparse case (e.g. node-only) — do not explode into every combination.
5. For large passthrough payloads (file dumps, stdout), show the **template/shape** with placeholders like `<stdout>`, not a real multi-KB dump. Note path scrubbing, truncation, caps.
6. Skip TUI-only paths quickly once confirmed.

## Output format

Emit exactly this shape. No preamble before the title.

````markdown
# Model-facing audit: <extension-name>

**Path:** <resolved path>
**Entry:** <entry file>
**Model surfaces used:** <short list, e.g. registerTool, execute results/errors — no systemPrompt inject>

<one or two lines on dynamics, e.g. "Strings depend on detected runtimes. Blocks below assume Python 3 + Node + Deno.">

## As the agent sees it

### Tool: `<name>` — description
```text
<fully expanded description>
```

### Tool: `<name>` — promptSnippet
```text
...
```

### Tool: `<name>` — promptGuidelines
```text
<guideline 1>
```
```text
<guideline 2>
```

### Tool: `<name>` — parameter schema
```text
field: description
  enum: [...]
field2: description
```

### Tool: `<name>` — success results
```text
...
```
```text
...
```

### Tool: `<name>` — errors
```text
...
```

### System prompt (`before_agent_start` / other)
```text
...
```

### Injected messages (`sendMessage` / injectFiles / …)
```text
customType=... when=...
<body or shape>
```

### Other (<surface>)
```text
...
```

## Not present

- <surface that was checked and absent, one bullet each for major misses only>

## Notes

- <only non-obvious issues: dead duplication across channels, wrong variant text, unbounded passthrough, etc.>
- Skip if nothing worth saying.
````

### Formatting rules

- **Primary artifact is the expanded text blocks** under “As the agent sees it.” That is the audit. Metadata stays minimal.
- One subsection per distinct channel (description, snippet, each guideline group, params, results, errors, each inject path, system prompt chunk).
- Put the real words inside ` ```text ` fences so the reader sees them as the model would, not paraphrased.
- Multiple guidelines or error strings = multiple fences (or one fence with clear blank-line separation if very short).
- Use placeholders only for truly variable payloads: `<stdout>`, `<id>`, `<path>`, `N`, `M`.
- If the extension has several tools, repeat the tool sections per tool, ordered as registered.
- If there is no tool and only system-prompt or inject paths, skip empty tool headings.
- Do not invent a severity rubric, finding IDs, or boundedness taxonomy unless the user asks.
- Do not dump source line tables as the main report. Location may appear in Notes when something is wrong or unclear.

## Constraints

- Read-only.
- Prefer incomplete-and-honest over speculative text.
- If truly nothing model-facing: title, path, “No model-facing surfaces,” and Not present list.
