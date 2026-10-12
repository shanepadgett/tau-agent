---
description: Safely update tau-agent dependencies and keep local config aligned with a user-provided pi reference repo
argument-hint: "[instructions]"
---
Maintain this tau-agent package against a local pi reference repo. Extra instructions: ${ARGUMENTS:-none}

First ask the user for the pi reference path unless they already provided one. Do not guess.

Use that path for:

- root `package.json` versions, engines, and tool config
- package versions from `packages/coding-agent`, `packages/ai`, `packages/tui`, and `packages/agent`
- `.npmrc`, `biome.json`, `tsconfig.base.json`, and `tsconfig.json` patterns worth mirroring

Rules:

- Keep Pi package dev dependencies pinned exactly to the reference versions.
- Keep published Pi peer minimums independent of development pins. Follow `AGENTS.md`'s Pi Compatibility rules; do not raise the minimum without an API requirement that lacks a safe fallback and explicit user approval.
- Keep TypeScript, Biome, Node, and `typebox` aligned when safe.
- Do not change package manager, relax checks, or delete local behavior without asking.
- If dependency versions changed, run `npm install --ignore-scripts`.
- Finish all work, then call `checks` before the final summary; do not run registered checks or their equivalents manually.
