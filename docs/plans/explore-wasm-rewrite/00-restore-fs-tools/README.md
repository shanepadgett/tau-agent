# Task 00 — Rebuild the filesystem tools

## Goal

A new, minimal `packages/agent/extensions/explore/` giving the agent back `ls`, `find`, and `grep`. **Write fresh code** — the user ruled out copying from `docs/plans/explore-archive/`; treat the archive as read-only prior art for behavior questions, never as a source to paste from. No AST anything in this task. `read` stays Pi's built-in until task 12.

## Behavior contract

Specs: `explore-specs/fs/ls.md`, `explore-specs/fs/find.md`, `explore-specs/fs/grep.md`, plus `cross/path-conventions.md` and `cross/output-density.md`. The archived implementations satisfied these; the specs, not the archive, are the acceptance criteria.

## Steps

1. Implement ignore-aware traversal, path display (`@` stripping, cwd-relative), compact path-tree rendering, and the three tools under `packages/agent/extensions/explore/`, alongside the existing `ast/` dir from task 01.
2. `grep` drives ripgrep (`rg --json`) as a child process; `ls`/`find` walk the filesystem directly. Shared count limits live in one small module.
3. `index.ts`: create the tool-row-state store (`packages/agent/shared/tool-row-state.ts`), register the three tools, wire session lifecycle only for state the tools actually own.
4. Tests under `packages/agent/test/extensions/explore/`; generic helpers come from `packages/agent/test/helpers.ts`.
5. New `README.md` in the extension dir (product level, AGENTS.md rule) and a short `## explore` section in `packages/agent/extensions/tau-help/help.md` covering just the three tools; both grow in later tasks.
6. Remind the user to `/reload`.

## Done when

`ls`/`find`/`grep` work in a live session per their specs; tests green; zero code copied from the archive.
