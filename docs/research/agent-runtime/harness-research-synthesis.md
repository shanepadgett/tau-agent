# Stateview research synthesis

Working codename: `stateview`.

No product code exists yet. This document explains what we should build, why, what to skip, and what still needs proof.

## The problem, in plain English

AI coding agents waste money and context because they keep dragging old junk forward.

A normal bad loop looks like this:

1. The agent searches for a symbol.
2. The search prints 80 matches.
3. The agent reads three files.
4. The search output is still in the prompt even though the files replaced it.
5. The agent edits one line.
6. The old file text is still in the prompt even though the file changed.
7. A check passes and dumps a giant log.
8. That useless passing log stays in every later model turn.

Now the model is paying attention to stale search hits, stale file text, and logs that no longer matter. Every future turn pays for those tokens. Worse, the model can accidentally trust old evidence.

The fix is to stop treating the chat transcript as the source of truth.

Keep exact details in local state. Send the model a small, current view.

## The basic idea

`stateview` is a context manager for coding agents.

It keeps a local record of what happened:

- files read
- search results
- edits made
- validation results
- open errors
- user decisions
- important constraints

Then, before each model turn, it builds a compact prompt view from that state.

The model sees enough to work. Full details stay available through lookup handles.

Example:

```text
@f3 src/user.ts lines 35..58 digest=9c31e2
35| export function getName(user: User) {
36|   if (!user.profile) return "unknown";
37|   return user.name;
38| }
```

The model sees readable file lines. Behind `@f3`, the harness stores the exact file snapshot, path, digest, and line data. Later the model can say: replace line 37 in `@f3`. The tool checks that the file still matches the digest, applies the edit, and returns an updated capsule.

If the file changed since read time, the tool fails instead of guessing.

That is the core product.

## Terms used in this project

### Provider context

The text and tool definitions sent to the AI model on a turn.

This is the expensive stuff. If it stays visible for ten turns, we pay for it ten times, even if caching makes it cheaper.

### Runtime state

Local state kept by Tau/Pi. It can be JSON files, a database, or in-memory plus persisted artifacts.

It stores exact details the model does not need to see every turn.

### Event log

A chronological record of things that happened.

Examples:

- user asked for feature
- `fs_search` found matches
- `fs_read` read a file
- `fs_apply` changed a file
- validator failed
- validator later passed

The event log is useful for audit and recovery. It should not be dumped into the prompt raw.

### Capsule

A small prompt-visible record that summarizes current useful state.

Examples:

```text
@f3 src/user.ts current lines 35..58 digest=9c31e2
@v7 TypeScript failed: src/user.ts:37 string not assignable to number
@s2 search "getName" covered by @f3 and @f4
```

A capsule is what the model sees. The exact body can live hidden behind a handle.

### Hidden handle

An ID that points to exact stored detail outside the prompt.

Examples: `@f3`, `@v7`, `@log12`, `@json4`.

A handle saves tokens, but it is not evidence by itself. If the model needs exact hidden content, it must expand or look it up.

### Digest

A fingerprint of file content.

The edit tool uses it to detect stale reads. If the file changed after the model read it, line numbers may no longer mean the same thing. V1 should fail safely in that case.

### Projection

Code that decides what goes into the next prompt.

It should keep current useful facts and hide retired noise.

Example rules:

- a file read can cover older search hits
- an edit supersedes old file text
- a passing validator resolves an older failure
- unresolved failures stay visible
- user requirements stay pinned

### Quiet validator

A check that only talks to the model when something is wrong.

Passing output stays hidden or status-only. Failure output becomes a short diagnostic capsule plus a hidden full log handle.

### Scope pack

A bundle of likely-relevant files or snippets loaded before the model wastes turns discovering them.

Good scope pack: selected files, failing stack trace files, import closure around a known symbol.

Bad scope pack: half the repo because we feel nervous.

### LSP

Language Server Protocol. Same kind of code intelligence editors use for rename, references, definitions, diagnostics, and organize imports.

Use LSP for semantic operations. Use search for strings.

## What the research says

### Small current views beat raw history

Keeping raw transcript is easy and cache-friendly, but it piles up stale evidence. Long sessions get expensive and sloppy.

Model-generated summaries are also risky. They tend to drop exact details, corrections, and user preferences.

The better default is deterministic projection:

```text
raw events -> typed state -> active capsules -> compact prompt view
```

No model call needed to decide that an old search result is covered by a newer file read. The harness can do that with normal code.

### Hidden file handles should be the normal edit path

The best ordinary edit path is:

1. read file with visible lines and hidden handle
2. model sends compact edit operations against that handle
3. tool checks digest
4. tool applies all edits in one batch
5. tool returns refreshed file capsule

This beats exact old-string edits because the model does not need to repeat the old text. It beats visible hashlines because every line does not carry a hash tax. It beats raw patches for normal current files because patches repeat context text.

`apply_patch` is still useful as a compatibility lane. It is also competitive when content moved after read time. It should not define the main architecture.

### Stale handles should fail in V1

If a file changed since the model read it, V1 should stop and ask for a reread.

Later we can add safe relocation:

- exact old block appears once: probably safe
- neighbor lines uniquely identify the moved block: maybe safe
- duplicate or fuzzy match: fail

Fuzzy/model relocation is where wrong edits come from. Wrong edits are more expensive than another read.

### Search should return useful context, not terminal dumps

Raw `rg` output is noisy. The search tool should group results and decide what to read next under policy.

Starting policy:

- owned source/test/config files up to `3k` estimated tokens can be whole-read
- files up to `5k` can be whole-read when scope confidence is high
- bigger files should be range-read around hits or symbols
- generated/vendor/dist/coverage/snapshots should not auto-read
- binary/assets should not be read as text

This policy matches the repo-size data:

- `3k` covers about 79-84% of owned text files in the big reference repos
- `5k` covers about 87-91%
- the giant offenders are generated files, lockfiles, schemas, fixtures, changelogs, and vendor blobs

### Scope packs help only when tight

A good upfront pack often beats wandering through search/read turns. One extra model turn can cost more than reading a small owned file.

Use a pack when:

- the user selected files or directories
- a failing test/stack trace points to files
- the expected discovery path is two or more model turns
- the pack is likely close to the useful context

Avoid a pack when:

- one exact search or read will answer it
- the pack would include 2x more context than needed
- generated/vendor files dominate
- the task is one tiny local edit

### Passing check logs should disappear

Passing logs are almost always wasted prompt space.

Failure logs matter, but the model usually needs only the important lines:

```text
@v7 TypeScript failed
src/user.ts:37 TS2322 string not assignable to number
src/api.ts:9 unused import
full log: @log12
```

When the next check passes, `@v7` should be resolved and removed from the active prompt view.

Auto-formatters need special handling. If a formatter changes a file, file capsules must update immediately. The model should not have to reread just because formatting ran.

### LSP should handle semantic work

Text edits are fine for local text changes.

LSP should handle:

- rename symbol
- find references
- go to definition
- diagnostics
- organize imports

LSP should not be a hard dependency. It can be cold, slow, misconfigured, or blind to stringly runtime conventions.

Fallback path stays important:

- search
- managed file reads
- code probes
- text edits

### Prompt caching changes the shape

Prompt text is rent. Tool schemas are rent. Dynamic system prompts are cache poison.

The stable part of the prompt should stay stable:

- core behavior rules
- stable tool schemas
- durable project rules

Volatile runtime state should go late:

- current posture/mode
- active capsules
- validator state
- continuation task

Current Soul-style posture rewrites system prompt content. That likely hurts caching. The better shape is a stable system prompt plus a late Tau runtime capsule.

### Tool schemas should be grouped and stable first

Generic dispatcher tools look cheap because the schema is tiny, but they cause wrong-tool choices and retries.

Many tiny tools are clear but expensive.

V1 should use coherent grouped tools:

- filesystem read/search/apply
- context budget/lookup
- validator/status

Mode-specific schemas might save tokens in stable modes, but we need actual provider request/cache data before making them core.

### Compact formats help, but readability still matters

Repeated rows should not be pretty JSON. Field names repeated hundreds of times are wasted tokens.

Good defaults:

- tuple rows with a legend for repeated search/diagnostic rows
- intern repeated strings like paths and status codes when large
- compact projection plus hidden raw JSON handle for arbitrary nested JSON

Pretty JSON should be an expand/debug view, not normal model context.

### Subagents are usually not the first answer

For local repo discovery, deterministic scouts/searches win. They return exact paths and ranges without prose.

Prose subagents are usually wasteful because the parent model rereads the files anyway.

Typed subagent output can help for broad web/research synthesis, especially when the output is a patch to context:

```json
{
  "add_context": [
    { "path": "src/auth.ts", "ranges": [[40, 90]], "reason": "token validation" }
  ],
  "drop": ["@s3"],
  "open_questions": ["confirm middleware order"]
}
```

That is later work. V1 should use deterministic local discovery.

## Recommended V1

Build one Tau/Pi extension first.

Do not split into a suite yet. The important pieces need one shared state store and one shared lifecycle model.

V1 should prove this loop:

```text
search/read -> capsules and hidden handles -> batch edit -> refreshed capsules -> quiet check -> compact next prompt
```

### V1 components

#### 1. State store

Keep records for:

- file reads
- search results
- hidden file snapshots
- mutations
- validator results
- hidden logs
- decisions/open questions

Minimum fields:

```text
id
type
path(s)
created turn
updated turn
visible text
hidden payload ref
digest/revision
state: active, covered, superseded, resolved, stale, failed
```

#### 2. Context projection

Before each model turn, compile the active state into a small prompt section.

The projection should:

- include current file capsules
- include unresolved failures
- include current goal/scope/constraints
- hide covered search results
- hide resolved validator failures
- hide passing logs
- keep user requirements visible or pinned

#### 3. `fs_read`

Read files into capsules.

Modes:

- whole file for small owned files
- ranges for large files
- targeted generated/vendor reads only when explicitly allowed

Output should be readable numbered lines plus a hidden handle.

#### 4. `fs_search`

Search and return grouped results.

It should know path policy:

- owned source/test/config/docs
- generated
- vendor
- assets/binary

It can auto-read ranges or whole small files under policy.

#### 5. `fs_apply`

Apply multiple file changes in one tool call.

Needed operations:

```text
= replace one line
~ replace inclusive range
< insert before line
> insert after line
- delete inclusive range
write/create file
delete file
move file
```

V1 safety:

- preflight all handles before writing
- fail if any handle is stale
- avoid partial mutation when preflight fails
- after successful mutation, return refreshed capsules

Full rollback can wait.

#### 6. `ctx_budget`

Show what is currently renting context.

Example:

```text
context view: 18.4k tokens
@f3 src/user.ts 2.1k active
@s2 search "getName" 0.8k covered by @f3, prunable
@v7 TypeScript failure 0.2k unresolved
hidden artifacts: 420k bytes
```

This should be product surface. If users can see context waste, they can trust the tool.

#### 7. Quiet validator lane

Start simple.

A tool or hook records:

- status-only pass
- compact failure capsule
- hidden full log handle

Later it can debounce, scope checks, cancel obsolete runs, and integrate auto-format.

## What V1 should skip

Skip these until the spine works:

- fuzzy stale-handle relocation
- full LSP tool suite
- prompt-intake classifier persistence
- no-bash lockdown mode
- generic dispatcher tool
- per-turn generated tool schemas
- broad automatic repo packs
- prose subagent orchestration
- fancy dashboard
- full transaction/rollback engine
- automatic vendor/generated deep reads

These are not bad ideas. They are downstream features. Build the state/view loop first.

## How V1 should behave on a real task

Example task: rename a helper and update a few call sites.

1. User asks for change.
2. `fs_search` finds likely files.
3. Search auto-reads small owned files or ranges.
4. Prompt shows `@f1`, `@f2`, `@f3` file capsules.
5. Model decides edits.
6. `fs_apply` patches all files in one call.
7. Tool checks digests first.
8. Tool writes changes.
9. Tool returns refreshed capsules.
10. Validator runs.
11. If pass: prompt gets no log.
12. If fail: prompt gets compact failure capsule.
13. Old search/read capsules are marked covered/superseded.
14. Next turn contains current state, not the whole messy path.

That is the behavior we need to prove.

## Policies to start with

### Read policy

| File kind | Default behavior |
|---|---|
| owned source/test/config <= `3k` tokens | whole read OK |
| owned source/test/config <= `5k` tokens | whole read only with high confidence |
| large owned files | range read |
| docs | read targeted ranges unless selected |
| generated/vendor/dist/coverage/snapshots | no auto-read |
| binary/assets | no text read |

### Mutation policy

| Case | Behavior |
|---|---|
| digest matches | apply operation |
| digest changed | fail and ask for reread |
| hidden handle missing | fail and ask for reread |
| duplicate target text | use handle/line/range, not text guessing |
| semantic rename/imports | later route to LSP |

### Validator policy

| Result | Prompt behavior |
|---|---|
| pass | hidden/status-only |
| fail | compact diagnostic capsule visible |
| fail then later pass | resolve old failure capsule |
| formatter changes files | refresh affected file capsules |

### Output policy

| Data shape | Visible format |
|---|---|
| repeated rows | tuple rows with legend |
| repeated paths/statuses | interned tuple rows |
| arbitrary JSON | compact projection plus hidden raw handle |
| shell output | reducer capsule plus hidden full log |
| pretty JSON/full log | expand/debug only |

## What still needs proof

No more broad spreadsheet simulations are needed before V1. The next proof should come from a prototype and small behavior tests.

### 1. Actual provider request/cache shape

We need to inspect real Pi provider payloads.

Questions:

- Where do tool schemas sit in the request?
- Does changing tools bust cache?
- Can Tau put volatile runtime after the latest user message?
- Can the context hook remove or replace raw transcript pieces cleanly?
- Can we read cached/uncached token accounting from providers?

This is the biggest unknown.

### 2. Model behavior with compact formats

Token savings do not matter if the model misunderstands the format.

Need small evals for:

- tuple search rows
- interned diagnostics
- compact JSON projection with hidden raw lookup
- file capsules with handles
- MRC-style KEEP/REF/DROP anchors

Measure retries and wrong assumptions.

### 3. Hidden lookup UX

The model must understand this rule:

```text
Visible capsule text is evidence. Hidden handles need lookup before relying on exact hidden content.
```

If the model treats `@log12` as if it knows the log, the design is unsafe.

### 4. LSP cold/warm timing

Need real timings on:

- `pi`
- `codex`
- `opencode`
- `tau-agent`

LSP should be lazy unless timings prove eager startup is cheap.

### 5. Stale-handle frequency

Strict stale failure is safest, but if it fires constantly the product will feel annoying. Measure on real editing loops before adding relocation.

### 6. Validator scope cost

Quiet validators still need to know what to run. Full checks after every edit may be too slow. Scoped checks can miss failures.

Start manual/user-invoked, then add dirty-scope mapping.

### 7. Prompt injection and secrets

File contents, logs, shell output, and web text can contain hostile instructions. Treat them as data, not control text.

Hidden logs can contain secrets. Probe/shell tools should default to no network and stripped environment.

## Success metrics

V1 is working if normal coding sessions show:

- fewer rereads after edits
- fewer repeated search/read turns
- lower active visible context over time
- passing checks no longer pollute prompt
- stale handles fail safely
- old search/read/check capsules retire automatically
- model can use file handles without confusion
- `ctx_budget` makes context waste obvious

Concrete demo target:

1. Search for symbol.
2. Auto-read relevant owned context.
3. Apply three edits across files in one call.
4. Return refreshed capsules.
5. Run/check quietly.
6. Show old search/read/check noise retired in `ctx_budget`.

If that works, the architecture is real enough for LSP, probes, and classifier work.

## Product shape

Build one extension first.

Suggested internal modules:

```text
state
projection
handles
fs-read
fs-search
fs-apply
path-policy
output-format
validators
budget
```

Later split pieces only if they become independently useful:

- LSP bridge
- shell/RTK reducer pack
- prompt-intake classifier
- no-bash policy profile

## Name

Old file-tool names are too narrow:

- `batch-fs`
- `hash-fs`
- `file-surgeon`
- `anchored-files`

They describe edit mechanics, not the actual product.

Best current codename: `stateview`.

It says what the harness does: keep state, compile a view.

Final name can wait.

## Recommendation

Build `stateview` V1 after approval.

First milestone:

- state store
- projection hook
- `fs_read`
- `fs_search`
- `fs_apply`
- `ctx_budget`
- compact validator/log capsule shape

Leave LSP, classifier, relocation, no-bash, and schema switching for later.

The product should prove one claim first: the model should work from current compact state, not a pile of old transcript junk.
