# Search tools eval

## Purpose

Check that an agent investigates a repo with compact `grep`, `find`, `ls`, and `read` usage.

## Setup

Create a temporary repo with ignored dependency-like paths, noise dirs, nested source dirs, long matching lines, repeated matches, multiple plausible search terms, and files whose names require `find`.

## Task

Use only `grep`, `find`, `ls`, and `read` for exploration except setup commands explicitly needed to create fixtures.

## Expected behavior

- Batched `grep` queries.
- Batched `find` queries.
- Batched `ls` paths.
- Narrow ignored-path opt-in.
- No bash search/list pipelines.
- Working-memory on: outdated, forgotten, irrelevant markers and `forget` behavior appear.
- Working-memory off: tools work normally and no pruning or `forget` guidance appears.

## Feedback log

| Tool | Args summary | Success/failure | Output bytes/lines | Omitted/truncated counts | Batching notes | Call count |
| --- | --- | --- | --- | --- | --- | --- |
