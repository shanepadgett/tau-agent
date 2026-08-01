# Agent-ready repository

Working notes on what makes a repo good for humans and coding agents. Core idea: put important procedure in machines and maps, not prompts. Model effort is for judgment leftovers.

Important paths should be verbs, not prompts. Important structure should be maps, not rediscovery. Important policy should be files, not vibes. Reuse should have an obvious home, not a scavenger hunt. Hygiene matters because lies in the tree become agent beliefs.

## Cold start

One documented path from a machine with nothing installed to a green verify command.

- Ordered, copy-pasteable steps. Full commands.
- One happy path for the default bootstrap. Still document manual/alternate installs where real (e.g. mise via curl vs brew); agents and humans pick on purpose, not by guessing.
- Optional bootstrap script that runs the default path (install missing tools, trust, deps, verify). Script does not replace the written steps; it implements them. Prefer generating one from the other so they cannot drift.
- Versions come from project pins (`mise.toml`, lockfiles), not vague minimums.
- Ends with one verify command that fails loud if bootstrap is wrong.
- Say what not to run when improvisation is harmful.
- Product install, contributor bootstrap, and deploy are separate labeled paths.
- README points hard at the canonical bootstrap doc if it lives elsewhere (e.g. CONTRIBUTING).

## Environment and verbs

- Reproducible toolchain: mise, devbox, devcontainer, compose, or similar. One bootstrap story.
- Named task runner (mise tasks, Just, npm scripts, etc.) for check, lint, test, build, and other real verbs.
- One verify entrypoint. CI runs the same thing locally does.
- Side-effectful ops (publish, release, migrate) are slash commands or scripts, not skills the model re-derives.
- Silent/automatic checks after edits where possible. Passes stay out of context. Failures return residual output only and may re-enter the agent.
- Tell the agent which commands are automatic so it does not double-run them.
- Tasks should be safe to re-run.

## Lint, format, and entropy

Wire mechanical taste into verify. Prefer fix-first, then report only what remains.

- Formatter and linter with quiet, agent-safe output (diagnostics only).
- Warnings as errors on the gate path when you mean them.
- Types/build gate when the language has one.
- Entropy suite when the ecosystem supports it: dead/unused code, duplication, complexity, import cycles/boundaries.
- Strict rules that encode architecture law (ban raw env access, `any`, wrong-layer imports, forbidden APIs).
- AGENTS.md says please; lint says cannot. Prefer the second for anything enforceable.
- If a language lacks tools, say so and lean on smaller modules, maps, and review instead of fake checkboxes.
- Calibrate duplication/complexity so they block real rot without perpetual alarms on old code (clean baseline or gate new/changed code first).

## Harness gates

Linters shape code. Harness limits shape what the agent is allowed to do.

- Sensitive read deny (secrets, keys, `.env`).
- Write-protect rail files: lint/config, CI, task runner, AGENTS policy, publish plumbing. Require user confirmation to change them.
- Command deny or confirm for destructive/irreversible ops (force push, recursive delete, prod deploy, raw publish).
- Optional write sandboxes and network allowlists.
- Fix-cycle and blast-radius budgets so the agent stops and reports instead of thrashing or disabling rails.
- Generated artifacts are read-only to the agent; one owned generator path.

## Policy and orientation

### AGENTS.md (thin, always on)

Root agent policy file (AGENTS.md or equivalent) is for **durable rules that apply to every task**, regardless of area or language. Not a handbook dump.

Put here:

- How to work in this repo at all: verify expectations, commit/PR norms, what never to do, harness quirks.
- Cross-cutting reasoning rules that always matter (build ladder, deepen don't smear, failure protocol).
- Language or stack rules that apply whenever that stack is touched *and* cannot be enforced well by lint/types/formatters. Prefer machines first; prose is the overflow valve.
- Pointers to where the rest lives (standards tree, vocabulary, golden paths, cold start)—not the contents of those docs.

Keep out:

- UI vs API vs feature playbooks (work-type standards + context packs + optional path nudges).
- Long tutorials, onboarding essays, every house preference someone once cared about.
- Anything a linter, typechecker, formatter, or entropy tool can own.

Same idea for every language, not TypeScript-only. Thin on purpose. Other rails carry the weight.

### Maps and exemplars

- Vocabulary file for core nouns so humans and agents share names.
- Feature / vertical-slice layout so work has obvious directory gravity.
- Context work packs (job-shaped file sets for recurring work units), maintained as the tree changes—not a full file dump.
- Named golden path per major artifact kind (extension, package, feature slice). One live canonical example beats many toy demos. Link it from policy docs. No in-repo anti-example folders; agents copy those too.
- Short architecture norms: either a few lines in AGENTS.md or a linked doc; details stay out of the always-on file.

## Reuse and standards

The build ladder (in-tree first, then stdlib, then approved deps, then new code) only works if the repo makes the upper rungs findable. Agent philosophy says "reuse"; the tree must show *where* and *how*.

Obvious homes:

- Shared UI / design system folder is the only place reusable UI is born and extended. Rules for atoms, composition, and when to split live next to that code or in a UI standard.
- Shared platform kits (math, time, money, errors, HTTP clients, env) have one owned package or directory. No third copy under a feature folder.
- Approved external packages are listed or implied by existing usage; agents use those APIs fully instead of hand-rolling a worse subset.
- Stdlib and already-installed deps beat new helpers. The repo should not make custom wrappers the loudest example unless they are the real law (e.g. env must go through platform).

Standards docs by work type:

- UI, HTTP/API, data/storage, extensions, infra each get a short standard when rules differ.
- Not dumped into AGENTS.md. That file points at the system; it does not host every playbook.
- Prefer attaching the right standard when a context work pack is selected (UI pack brings UI standard, API pack brings API standard). Pay once to wire; cheap every later task.
- Standards say: where reuse lives, how to extend it, what not to reinvent, which package APIs are canonical.
- Golden paths double as reuse exemplars: the canonical slice imports from the shared homes the house way.
- Optional: path-triggered standards nudges while the agent explores (local extension). Point at the doc; do not inline it until intent is to work there. See `docs/plans/standards-nudge-extension.md`.

Enforce what you can: boundary lint so features cannot grow private UI kits; dead-code/dup so paste-bots lose; review when someone adds a parallel helper next to a shared one.

## Architecture

Make the correct extension point the easiest place for the next change.

- Prefer deep modules: small interface, strong internals, invariants at the boundary.
- Does not require classes. Use structure that fits the problem: state machines, pipelines, typed boundaries, parsers and discriminated unions, table-driven rules, pure core with impure shell.
- Explicit states/transitions for real lifecycles. Avoid boolean and flag soup.
- Small public surfaces; private/internal by default.
- Import or package boundary checks when there are layers or multiple packages.
- Encode what you can (types, exhaustiveness, boundaries, complexity). Leave true design judgment to humans and architecture review.
- Smells to reject: parallel helpers next to the canonical path, flag accretion, god options bags, one-implementation interfaces, stringly protocols, cross-slice private reach-in, dual sources of truth.
- High-churn hotspots may signal missing module boundaries. Separate idea: Tau support to surface churn and ask whether re-architecture would reduce it — see `docs/plans/churn-architecture-analysis.md`.

## Deterministic markers (not comment novels)

Do not litter the tree with prose that explains every line to the agent. Do use a **small, greppable marker vocabulary** for facts machines and agents should be able to sweep.

Shared shape (pick one house syntax and stick to it), e.g.:

```text
// @agent kind=until remove-when="real auth ships" replace-with="platform auth client"
// @agent kind=temp remove-when="feature X lands"
// @agent kind=invariant claim="session id is opaque to UI"
// @agent kind=stub owner="billing" next="wire real gateway"
```

Kinds that earn their keep:

- **until / temp** — code not in final shape. States *when* it dies or changes and *what* replaces it. Stops agents from deepening a scaffold (dev auth that must vanish, feature flags mid-migration, temporary dual-write).
- **invariant** — a law this module must keep. Not a tutorial; one claim. Pair with a test or checker when possible ("invariant ticket": claim in code + proof nearby). If the claim moves, the proof moves in the same change.
- **stub / extension-point** — intentional incomplete surface; where the real implementation goes later.
- **generated** — do not hand-edit; regen verb instead.
- **rail** — policy/config the agent must not casually rewrite (optional if harness gates already protect the path).

Operational rules:

- Fixed prefix so `rg '@agent kind='` (or equivalent) is a real tool in the workflow.
- Sweep on purpose: before expanding an area, before release, during readiness harvest, when closing a multi-session feature.
- Expired `until`/`temp` markers fail verify or show up as a task list — stale scaffolding should not be invisible.
- No narrative comments that restate the code. If it is not actionable or sweepable, it does not get a marker.

## Learning from sessions

Human-triggered, not autonomous constitution rewriting.

- **Readiness harvest prompt** — run on a session that taught something (hard bug, good path, repeated footgun). Distill concrete repo improvements: standards gaps, missing verbs, cold-start holes, markers to add, context packs, lint rules, golden path drift. Output a short proposal the human accepts or rejects. See `docs/plans/session-readiness-harvest.md`.
- **Taste replay** — when a human rejects a pattern ("why is this a new helper?"), file it as a durable micro-rule in the right standard or lint — not left only in chat history.

## Autonomy loop

Trusted autonomy is supervised law with unsupervised compliance:

1. Act
2. Auto-format / auto-fix
3. Residual diagnostics only
4. Small retry budget
5. Still failing → human with evidence
6. No opportunistic refactors while remediating a failure
7. Successful turns should leave the repo stricter (less dead code, better map), not messier
8. Occasional human-triggered harvest when a session revealed a readiness gap

## What a readiness check could score

Deterministic or nearly so:

- Canonical cold-start doc exists and references real tool files; bootstrap script matches doc if both exist
- Verify task exists; CI parity likely
- Greppable marker vocabulary documented if the repo uses temp/until/invariant markers; sweep task optional
- Formatter/linter/types/entropy wired when expected files exist
- Thin AGENTS.md (always-on law + pointers), vocabulary, task runner, bootstrap tool config present
- Golden path linked
- Shared reuse homes exist and are named (UI kit, platform utils, etc.) when the repo has that kind of code
- Work-type standards docs exist; AGENTS.md does not absorb them
- Context packs can attach relevant standards
- Optional path→standard nudge map if the repo uses exploratory discovery a lot
- Context catalog present if the project claims to use it
- Silent automatic checks configured

Judgment or heavier tooling:

- Bootstrap actually works on a clean machine (best: clean container CI)
- Modules are deep; golden path is still canonical
- Reuse homes are actually used; features are not growing shadow design systems
- Lint rules encode real law, not only style
- Harness gates exist and rail files are protected
- Architecture review happens on non-trivial work

## Non-goals

- Replacing specialized tools (context, silent checks, publish) with one mega-extension
- Mandating one toolchain (mise vs devbox vs something else) over "has a bootstrap + verify"
- Ceremony architecture (DDD theater, everything must be a state machine)
- Skills for procedures that should be verbs

## Possible product shapes later

- **Agent readiness extension** (report + per-area improve) — `docs/plans/agent-readiness-extension.md`
- Local standards-nudge extension — `docs/plans/standards-nudge-extension.md`
- Session readiness harvest prompt — `docs/plans/session-readiness-harvest.md`
- Churn → architecture analysis (Tau) — `docs/plans/churn-architecture-analysis.md`
- Harness gate extension separate from readiness
- Steward that diffs readiness reports over time (later)

Doctrine in one line: encode law in machines, keep model effort for judgment, protect the encoders from the model, and make every successful turn leave the tree clearer than it found it.
