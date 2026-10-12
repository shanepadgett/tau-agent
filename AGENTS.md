# Agents

## Standards

Read a standard only when you are about to change something it covers. Reading or discussing that area is not enough.

| Standard | Read when |
| --- | --- |
| [standards.md](docs/standards/standards.md) | Changing `AGENTS.md` or any file in `docs/standards/`. |
| [code.md](docs/standards/code.md) | Writing or changing code in `src/`, `tools/` or `tests/`. |
| [planning.md](docs/standards/planning.md) | Planning work, in chat or in `docs/plan/`. |
| [spikes.md](docs/standards/spikes.md) | Creating or changing a spike in `spikes/`. |

## Rules

- When the user says they want to consider something, record it in `docs/plan/` in the same reply.
- Never put temporary or throwaway code in `src/`. Experiments are spikes.
- Before writing or planning code that uses a dependency, find its entry in `docs/reference/copies/index.md` and read the API there. Never guess an API; run `mise run docs` after a dependency version changes.
- Do not change check configuration or bypass a check without the user's permission. This covers lint, format, type, dead-code, boundary and test settings, our lint rules, and suppression comments (`oxlint-disable`, `@ts-expect-error`, fallow ignores). When a check blocks you, stop, tell the user what fails and what change you propose, and continue only if they agree.
- Do not commit unless the user gives you permission; otherwise, the user commits.
- Lint rule tests run under Node because oxlint's `RuleTester` does not support Bun (oxc issue 26740). When the current date is after 2026-11-12, ask the user whether to check if it now works under Bun, and keep asking each session until they answer.
