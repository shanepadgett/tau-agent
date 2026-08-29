# Cost Report Extension — product criteria

Product criteria + implementation notes.

Implemented under `packages/agent/extensions/cost-report/` (`/cost-report`).

## Objective

On-demand lookback over local sessions: spend for a chosen window, enough breakdown to see where it went.

## Design sketch

Working HTML template (layout + design system, sample numbers only):
`docs/plans/cost-report-sketch.html`

- `body.scope-all` vs `body.scope-project` toggles all-only blocks.
- Not production rendering yet — iterate visuals here first.

## TUI flow

Reach order per `packages/agent/docs/tui.md`.

### Pickers (Pi built-in)

Use `ctx.ui.select()` twice — fixed short lists, no custom panel needed.

1. **Time frame** (required, no default)
   - Past 7 days
   - Current week
   - Current month
   - Year to date
   - Specific month… (then month, then year)
2. **Scope** (required, no default)
   - Current project
   - All sessions

Cancel on either aborts; no report.

### Working UI (editor takeover)

After both picks: `ctx.ui.custom(...)` owns input so the user cannot type into the chat editor.

Reuse from `@shanepadgett/tau-tui`:

- **`ToolPanel`** — bordered shell, title, body, footer hints
- Body: simple status text (and optional Pi **`BorderedLoader`** if it fits cleanly inside the panel)
- Hints via `bindingHint` / `bindingsHint` — Escape/cancel only while running if we support abort

Do **not** use `setWidget` (glanceable, no focus ownership).
Do **not** invent a new shared list component for two fixed selects.

States inside the panel:

1. Scanning sessions… (`n` / `total` when known)
2. Building report…
3. Writing file…

On success: **close the custom UI completely**, write the file, **open it in the default browser**, then `ctx.ui.notify` with the output path.
On failure: close custom UI, `notify` error (no open).
On cancel: close custom UI, quiet or short notify (no open).

Open via platform default (`open` / `xdg-open` / Windows equivalent), same idea as crumbs cost-report.

### ASCII (terminal)

**Select time frame** (`ui.select`):

```text
Time frame

❯ Past 7 days
  Current week
  Current month
  Year to date
  Specific month…
```

**If Specific month…** — month, then year:

```text
Month

❯ January
  February
  …

Year

❯ 2026
  2025
  …
```

**Select scope**:

```text
Scope

❯ Current project
  All sessions
```

**Working panel** (`ToolPanel` via `ui.custom`):

```text
┌ Cost report ─────────────────────────────────────┐
│                                                  │
│  Scanning sessions…  42 / 180                    │
│                                                  │
│  Month to date · All sessions                    │
│                                                  │
├──────────────────────────────────────────────────┤
│  esc cancel                                      │
└──────────────────────────────────────────────────┘
```

Then panel gone. Toast-style notify:

```text
Cost report written · ~/.pi/tau/cost-reports/cost-report-mtd-all-2026-08-26.html
```

## Output path

Directory: `~/.pi/tau/cost-reports/`
(same tau home root as stash: `~/.pi/tau/…`)

Create dir on write if missing.

## Filename

Pattern:

```text
cost-report-<range>-<scope>-<YYYY-MM-DD>.html
```

- `<range>` short slug:
  - live: `7d` | `week` | `month` | `ytd`
  - specific month: `2026-03` (year-month of the **report window**, not generate day)
- `<scope>`: `project` | `all`
- For live windows, append `-<YYYY-MM-DD>` = **local date when generated**
- For specific month, the range slug already has year-month; still append generate date if we want uniqueness, or omit — **prefer**:
  - live: `cost-report-month-all-2026-08-26.html`
  - specific: `cost-report-2026-03-all.html` (window identity is enough; overwrite on regenerate)

Examples:

- `cost-report-month-all-2026-08-26.html` (current month, generated 26 Aug)
- `cost-report-7d-project-2026-08-26.html`
- `cost-report-ytd-all-2026-08-26.html`
- `cost-report-2026-03-all.html` (March 2026)

Same range+scope same day → overwrite (simple). No multi-version clutter unless we decide otherwise later.

Always open the written HTML after a successful write.

Empty result: warning notify only — no file, no open.

## Time frame

Chosen via selection menus. No free-form day counts.

Week boundary: **Monday start, Sunday end** (local).

### Live windows (single pick)

| Id | Label (draft) | Window |
| --- | --- | --- |
| `past-7-days` | Past 7 days | Rolling 7 local days ending now |
| `current-week` | Current week | This Mon 00:00 → now |
| `current-month` | Current month | Local calendar month start 00:00 → now (MTD) |
| `year-to-date` | Year to date | Local calendar year start 00:00 → now |

### Specific calendar month (extra menus)

| Id | Label (draft) | Flow |
| --- | --- | --- |
| `month` | Specific month… | After this choice: pick **month**, then pick **year** |

- Window: that calendar month, local midnight start → end of last day of month (or through now if it is the current month — same bounds either way is fine if we clamp to now for “today”).
- Year list: years that actually have sessions (if cheap), otherwise a short recent-year list plus current year. Prefer **only years with data** when scanning makes that easy; otherwise current year and a few back.
- Month list: Jan–Dec (disable or omit months with no data later if we want; v1 can show all 12).

### Semantics

- Timezone: local machine.
- Live windows end at **now**.
- Specific month: full calendar month in local time.
- **Empty period:** no HTML, no open. `notify` **warning** that nothing was found for that range/scope.
- Do not write a zeroed report file for empty runs.

## Scope

Selector after you run the command. **No default** — you must pick.

| Id | Label (draft) | Meaning |
| --- | --- | --- |
| `project` | Current project | Sessions tied to this workspace / cwd |
| `all` | All sessions | Every Pi session on the machine in the window |

- Core cost metrics are the same in both scopes.
- `all` adds a **project** dimension: spend broken out (and filterable) by projects touched in that window.
- `project` has no cross-project slice; everything is already one project.
- Exact “belongs to this project” rule follows however Pi/Tau already keys sessions to cwd/workspace.

## Command

`/cost-report`

## Flow (so far)

1. Run `/cost-report`.
2. Pick time frame (required).
   - If **Specific month…**: pick month, then year.
3. Pick scope: project vs all (required).
4. Working panel → write / open / notify (or empty warning).

Order of time frame vs scope flexible; specific-month submenus stay attached to the month choice.

## Report content

### Shared (project + all)

- Total spend for the window (and supporting token totals as useful).
- Cost by model.
- Sessions ranked by cost (high → low).
- Each session row: cost, models used in that session, enough identity to know what it was (name/path/when — exact fields later).
- **Daily spend grid** (GitHub-contribution style boxes for each day in the window):
  - Color runs green → yellow/orange → red by that day’s spend.
  - Shift off pure green starts above **$10**/day.
  - **$50**/day is bright red.
  - **>$100**/day: fire emoji on that cell (money-on-fire gag).
  - Empty / zero days still show as empty-ish green/neutral cells so the calendar shape holds.
  - **Cell count = days in the chosen window only** (past 7 → 7 cells, current week → days Mon→today, MTD → days so far this month, etc.). No padding out to a full month when the range is a week.

### All scope only

- **Projects ranked by cost** (high → low): spend, session count, other high-level counts that help compare projects.
- Session list includes **which project** each session belongs to.
- **Filter sessions by project** (dropdown / equivalent) so you can narrow the session list to one project without re-running as project scope.

### Project scope

- No project ranking block (single project).
- Session list has no project column / filter.

## Subagent spend

- Child runs are in-memory → not separate session files.
- Parent `subagent` tool results carry cost (`usage`) and **which agent** (`details.agent`, e.g. scout, web-research).
- Report should show:
  - Direct (parent assistant) vs subagent total
  - **Subagent spend by agent type** (stack-ranked)
- Gaps: missing usage on some results; pre-feature history; no tool result → invisible.
- No double-count if we sum parent assistant usage + parent subagent tool-result usage only.
- Output surface (TUI / HTML / both) — filter dropdown implies interactive HTML or rich TUI, not plain static text alone
- Privacy defaults
- Command name
- Whether model mix is global-only or also per project when filtered
