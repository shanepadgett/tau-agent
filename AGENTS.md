# Agents

## Standards

Read a standard only when you are about to change something it covers. Reading or discussing that area is not enough.

| Standard | Read when |
| --- | --- |
| [standards.md](docs/standards/standards.md) | Changing `AGENTS.md` or any file in `docs/standards/`. |
| [planning.md](docs/standards/planning.md) | Planning work, in chat or in `docs/plan/`. |
| [spikes.md](docs/standards/spikes.md) | Creating or changing a spike in `spikes/`. |

## Rules

- When the user says they want to consider something, record it in `docs/plan/` in the same reply.
- Never put temporary or throwaway code in `src/`. Experiments are spikes.
- Do not change check configuration or bypass a check without the user's permission. This covers lint, format, type, dead-code, boundary and test settings, our lint rules, and suppression comments (`oxlint-disable`, `@ts-expect-error`, fallow ignores). When a check blocks you, stop, tell the user what fails and what change you propose, and continue only if they agree.
- Do not commit unless the user gives you permission; otherwise, the user commits.
