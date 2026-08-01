# Agent readiness extension (shape)

Product plan for turning `docs/plans/agent-ready-repository.md` into a Tau extension. Related: standards-nudge (local), session harvest, churn analysis — stay separate unless they share scanner code.

## Opinion (not a wizard blob)

Two user jobs, one taxonomy, one extension:

| Verb | Job |
| --- | --- |
| **Report** | What is true about this repo right now, with evidence |
| **Improve** | Walk one narrow area until that area is in better shape |

Do **not**:

- One giant “setup my repo” chat in the coding agent (context sludge, no structured output)
- Fake numeric scores
- Force every criterion through an LLM
- Ship repo-private ops (publish, etc.) inside this extension — only teach the pattern; local extensions stay local
- Merge standards-nudge or harvest into v1 (different triggers). Share criterion IDs later if useful.

**Keep it simple.** `/ready` is a short selector flow + file output + notify. No report TUI, no on-disk JSON cache, no `/ready report` or `/ready render` subcommands for v1.

In-memory structured report (TS object) from the run → one deterministic template render (markdown **or** HTML) → timestamped file (local timezone in the filename) → `notify` with path.

Prompts alone are enough for Improve v0 later. Report v1 is scan-only. Extension owns the surface; improve playbooks can arrive later as the same command family or sibling prompts.

## Shared taxonomy (areas)

Stable IDs used by report rows and improve flows. Align names with the readiness doc.

| ID | Area |
| --- | --- |
| `cold-start` | Clean-machine path, bootstrap script/doc, verify |
| `toolchain` | Pin manager (mise/devbox/…), task runner, CI parity signal |
| `verify` | Single check entry, silent-command-runner hooks, agent-quiet fix-first |
| `lint-entropy` | Format, lint, types, dead/dup/complexity when ecosystem allows |
| `policy` | Thin AGENTS.md, vocabulary pointers |
| `standards` | Work-type standards tree, not dumped into AGENTS |
| `context` | `.pi/contexts` packs, optional validation settings |
| `reuse` | Obvious shared homes (UI kit, platform utils, …) |
| `markers` | Greppable temp/until/invariant vocabulary (if used) |
| `harness` | Gates/protections pattern (mostly guidance + detect known config) |
| `side-effect-verbs` | Guidance: publish/migrate as local commands, not skills |

v1 can ship a subset end-to-end and leave the rest as `unsupported` / `manual` rows.

## `/ready` (v1)

### Pipeline

```text
1. Selector: markdown or HTML (and later: which areas to audit)
2. Deterministic scan (no model) → in-memory ReadyReport
3. Render chosen format from static template + in-memory data
4. Write one file under .pi/tau/ready/ (or similar) with local-timezone timestamp in the name
5. Notify path (+ optional one-line counts in the notify string)
```

No JSON artifact. No re-render-from-cache command. Run again if you want a new file.

Parent coding agent does not ingest the report unless the human points it at the file.

### Row model (no scores)

Each criterion something like:

- `id`, `area`
- `status`: `pass` | `weak` | `missing` | `na` | `unknown`
- `how`: `scan` | `judgment` | `mixed`
- `evidence`: short facts (paths found, commands detected)
- `note`: one-line meaning
- `next`: optional concrete action (`/ready improve lint-entropy`, “add docs/CONTRIBUTING.md cold-start section”, …)

`na` = ecosystem or repo shape does not apply (no UI → UI standard na).  
`unknown` = judgment failed or skipped.

Rollups: counts per status per area. Not a single grade.

### Deterministic scan: general vs language packs

Two layers. Do not bury general rails inside TypeScript-only logic.

```text
Language detection (extensions, lockfiles, package manifests)
        │
        ├─► General scanner (always)
        └─► Ecosystem pack(s) for detected languages (union in monorepos)
        │
        ▼
   Facts + criterion rows (pass/weak/missing/na)
```

#### General (language-agnostic)

Same criteria whether the repo is Go, Swift, TS, or mixed. About **agent harness + repo orientation**, not compilers.

| Concern | Scan signals (examples) |
| --- | --- |
| Cold start | CONTRIBUTING/README/HACKING sections, bootstrap script paths, “clean machine” headings |
| Toolchain pin | `mise.toml`, `devbox.json`, `.tool-versions`, `.devcontainer/`, `flake.nix`, … (any one) |
| Task runner | mise tasks, `justfile`, `Makefile`, `package.json` scripts, `taskfile.yml`, … |
| Verify entry | Conventional names: `check`, `verify`, `ci`, `lint`+`test` combo documented as the gate |
| CI parity | Workflow/yml references same verify command (heuristic) |
| Silent checks | Tau `silentCommandRunner` (or documented equivalent) configured |
| Policy | `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md` etc. exists; byte/line budget → oversized = weak |
| Vocabulary | `VOCABULARY.md` or configured path |
| Standards tree | Globs only: `docs/standards/**`, `.pi/standards/**`, … — count files, not quality |
| Context packs | `.pi/contexts` present, parseable, non-empty |
| Markers | Configured prefix hits (`@agent kind=`) — optional |
| Side-effect verbs | Detect local pi/tau extensions or scripts named publish/release/migrate (presence only) |
| Harness gates | Known settings keys if present; else leave to guidance/judgment |

Judgment lanes (cold-start quality, standards substance, context shape, …) stay **general** too — they read prose and structure, not `gofmt` vs `oxfmt`.

Improve playbooks for these areas are general: “write a cold-start doc”, “split standards by work type”, “wire silent runner to your verify task”.

#### Ecosystem packs (per language / runtime)

Data, not hard-coded `if typescript` soup in random places. Each pack declares what **good mechanical taste** can look like for that ecosystem and how to detect it.

Per pack roughly:

```text
id: typescript   # go, swift, python, rust, …
detect:          # any → pack active
  - files: package.json, tsconfig.json, …
  - extensions: ["*.ts", "*.tsx"]
capabilities:    # ceiling of readiness, honest na when absent
  format:
    tools:
      - name: oxfmt
        detect: [.oxfmtrc.jsonc, …]
        agentQuiet: true   # known good flags or “default ok”
      - name: prettier
        detect: [prettier.config.*, .prettierrc*]
  lint:
    tools:
      - name: oxlint
        detect: [.oxlintrc.jsonc, …]
      - name: eslint
        detect: [eslint.config.*, .eslintrc*]
  types:
    tools:
      - name: tsc / tsgo
        detect: [tsconfig.json]
  entropy:
    dead:
      - name: fallow
        detect: [.fallowrc*, fallow in package.json]
    complexity: …
    duplication: …
    boundaries: …
  verifyHints:   # how improve playbooks usually wire tasks
    - "mise run check" / npm script patterns
```

Scan behavior when a pack is active:

1. For each capability (`format`, `lint`, `types`, `entropy.*`): **found** one of the known tools → pass/weak from config richness; **none found** → `missing` (not `na`).
2. Capability omitted from pack or pack says unsupported → criterion `na` with note “no mature tool in pack catalog” (ceiling, not failure).
3. Unknown tool configured by repo (custom script) → `unknown` or weak pass if verify task shells out to something scan cannot classify — prefer detecting via task body strings when cheap.

Monorepo: detect **all** languages above a noise threshold; union packs; report per-language subsections under `lint-entropy` so Go green + TS missing entropy is visible.

#### Ceiling of readiness (important)

Report should show two different ideas:

- **Applied** — what this repo actually wired
- **Possible** — what the active packs say is available for these languages

A Swift repo with great AGENTS/context/standards and weak dead-code tooling can be **fully ready on general rails** and **na/missing on entropy** without shame. Improve playbook says: lean on markers, smaller modules, review — not “install Fallow” on a language that cannot run it.

Inverse: TS repo with no Fallow/oxlint is `missing` on capabilities the pack knows exist.

#### What stays judgment / improve even when general

Deterministic scan cannot finish these; still language-agnostic process:

- Confirming standards content with the human and editing them
- Authoring context pack boundaries
- Local standards-nudge extension map (repo-shaped)
- Whether AGENTS is thin enough in spirit (size is only a hint)

Language packs feed **improve lint-entropy** only: which tools to offer, config filenames, quiet flags, task snippets. They do not own standards or context.

#### Pack maintenance

- Start with languages Tau already cares about (TS/JS first; Go/Swift/Python/Rust as data allows)
- Incomplete pack better than silent wrong `na` — mark capabilities `unknown` if catalog is TBD
- User settings can add tools or override detect paths without forking the extension
- Do not pretend the catalog is exhaustive; evidence string lists what was searched

Research draft catalogs (detect signals, ceilings, improve defaults): `docs/plans/agent-readiness-ecosystem-packs.md` — TypeScript, C#, Go, Rust, Odin, Java, Kotlin, Swift.

Scan emits facts, not sermons.

### Judgment lanes (LLM, narrow)

Only when quality matters and files exist (or should):

| Lane | Question |
| --- | --- |
| `cold-start-quality` | Can a stranger follow doc from zero tools to green verify? Ordered? Alternates labeled? |
| `policy-thinness` | AGENTS always-on vs dump? Pointers out? |
| `standards-quality` | Real law vs empty headings? Work-type split? |
| `context-quality` | Job-shaped packs vs file dumps? |
| `reuse-homes` | Shared UI/platform obvious or shadow copies? |

Each lane: fixed tool allowlist (explore/read), small output schema (status + evidence + next), cheap/fast model, hard cap on files/bytes. Prefer **one subagent per lane** for isolation and cancel/retry; run parallel with a concurrency limit. If cost hurts, sequential or merge “docs quality” into one lane with sectioned schema.

Do not send the whole monorepo. Seed each lane with scan facts + candidate paths only.

### UX

- `/ready` → simple selector: **Markdown** or **HTML** (pi select/editor pattern already used elsewhere — not a custom report panel).
- Scan runs, builds report in memory, writes **one** file:
  - e.g. `.pi/tau/ready/ready-2026-04-08-1430.md` or `.html`
  - timestamp in **local timezone**, human-readable, not UTC-Zulu in the name
- `ctx.ui.notify` with the absolute/relative path (and maybe `12 pass · 3 weak · 2 missing`).
- HTML/md from static templates; sections from areas/rows. No LLM-generated markup.
- Same in-memory shape later feeds judgment-enriched rows without changing the exit path (still: render file → notify).

## `/ready improve <area>`

Narrow guided setup/remediation for one area ID.

### Shape

- Extension resolves area → playbook (prompt markdown + scan facts for that area)
- Runs in **isolated session** (review-like) or offers “send playbook to current agent” — prefer isolated so the coding thread stays clean; human applies or accepts patches via export/send
- Playbook instructs: read scan facts, inspect only relevant paths, implement minimal rails for this area, do not boil ocean
- Output: done checklist + remaining human decisions + files touched

Split playbooks beat one mega-prompt. Series of prompts is right; the extension is the router and fact injector.

### v0 shortcut

If isolated improve is heavy, ship report first + project prompts:

- `/ready-improve-cold-start`
- `/ready-improve-verify`
- …

Extension still owns report; prompts are stub improve until upgraded. Prefer one command namespace long-term (`/ready improve …`) so UX does not fork.

## What is not this extension

| Thing | Where |
| --- | --- |
| Path→standard soft nudge + post-edit inject | Local `standards-nudge` plan |
| Distill session → readiness proposals | `session-readiness-harvest` prompt/extension |
| Churn hotspots → architecture advice | `churn-architecture-analysis` |
| Actual `/publish` etc. | Repo-local extensions |
| Implementing Fallow/oxlint | Improve playbook may install/wire; tools stay upstream |

## Settings (minimal)

- Criterion enable/NA overrides
- Standards/context/marker globs if non-default
- Judgment on/off (scan-only report)
- Model override for judgment lanes
- Export directory

No scoring weights. No gamification.

## Build phases (logical groups)

Few large chunks. Each phase should leave something runnable. Sibling plans (standards-nudge, harvest, churn) stay out until this core exists.

### Phase 1 — Deterministic `/ready` ships

**Implemented** in `packages/agent/extensions/ready/`.

- Criterion taxonomy + in-memory row model (pass/weak/missing/na/unknown; `how: scan`)
- General scanner + language detect + packs (TS/JS, Deno, thin Go/Rust)
- `/ready` → format selector (md | html) → template render → `.pi/tau/ready/ready-<local-tz-stamp>.{md,html}` → notify counts + path
- No settings, no JSON cache, no report TUI, no judgment

**Done when:** `/ready` on this repo and a stranger repo writes a useful md or html file with no model calls.

### Phase 2 — Judgment (later; scaffolding already fits)

Same `/ready` entry. Extra selectors for **what to audit** (areas / judgment-worthy lanes). Always run deterministic scan first into the same in-memory report, then optionally enrich rows:

- fire-and-forget or awaited child/background work (exact Pi hook TBD: isolated session, one-shot message, etc.)
- merge judgment into rows (`how: judgment|mixed`)
- single render + notify at the end (or notify twice: scan file then final — product choice later)

No need for JSON cache or render subcommand for that. Selectors + in-memory report + file out still hold.

**Done when:** user can opt into a quality lane and get one enriched file without a report TUI.

### Phase 3 — Improve flows

Turn “next” into guided remediation for top areas.

- `/ready improve <area>` router + scan-fact injection
- Playbooks for **`verify`** and **`cold-start`** first (highest leverage); then **`lint-entropy`** driven by active packs (Fallow-first on TS)
- Prefer isolated improve session; structured “what changed / what’s left for human” result
- Wire report `next` actions to improve commands

**Done when:** scan says missing verify or cold-start → improve playbook can actually add rails in a real repo with human accept.

### Phase 4 — Pack depth + remaining areas

Expand without redesigning the extension.

- Flesh ecosystem packs from `agent-readiness-ecosystem-packs.md` (Go, Rust, Swift, C#, JVM, Odin ceilings)
- More improve playbooks: policy, standards, context, markers, reuse homes
- Harden monorepo language thresholds, CI-parity heuristics, applied-vs-possible display
- README + tau-help

**Done when:** multi-language repos get honest ceilings; improve covers the taxonomy you care to support.

### Later / separate (not required for “readiness v1”)

- Session readiness harvest prompt
- Local standards-nudge extension
- Churn → architecture analysis
- Report history diff / steward

## Open decisions

- Output directory default (`.pi/tau/ready/` vs project-root `ready-reports/`)
- Timestamp filename format (local tz)
- Improve isolated vs in-parent when phase 3 exists
- How aggressive CI-parity detection is
- Phase 1 pack set: TS-only vs TS+Go+Rust thin stubs
- Noise threshold for “language present” in monorepos
- Phase 2: how judgment is triggered (await vs background) — defer until building it
