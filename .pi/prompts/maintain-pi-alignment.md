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
- Keep peer dependency strategy as-is unless the user asks.
- Keep TypeScript, Biome, Node, and `typebox` aligned when safe.
- Do not change package manager, relax checks, or delete local behavior without asking.
- If dependency versions changed, run `npm install --ignore-scripts`.
- Run `mise run check` after edits.
