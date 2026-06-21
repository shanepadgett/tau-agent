---
description: Explore a new elite single-page benchmark report design without copying prior attempts
argument-hint: "[brief]"
---
Design a new Tau benchmark report concept. Extra brief: ${ARGUMENTS:-none}

Goal: keep exploring single-page HTML report design systems until one floors the user. These are public-facing evidence pages for Tau/Pi benchmark outputs. They should feel designed by an elite designer: inspired by references, never copied. Pick your own concept, palette, type, spacing, hierarchy, and visual system after thinking. No template cosplay.

## Hard rules

- Create a new Tailwind CDN HTML prototype under `docs/plans/fs-tool-research/` named `report-design-baseline-vN.html`, where `N` is the next unused version.
- Do not read any existing `report-design-baseline*.html` before designing.
- Do not read any existing `docs/plans/fs-tool-research/design-captures/*.png` before your own design is implemented and iterated.
- Before designing, choose exactly one reference bucket from this prompt. Read only images from that bucket. Do not browse every reference image.
- Reference images are inspiration only. Do not copy layout, colors, fonts, shapes, marks, or composition directly.
- Use Tailwind CDN. Custom CSS is allowed for real graphic effects, SVG filters, masks, animation, texture, or chart visuals.
- No random dots, decorative pill tags, AI-tell confetti, fake complexity, generic glow, or blueprint/grid reuse unless the concept truly demands it.
- Report = shareable evidence page. Adjacent CSV/JSON/raw artifacts may be referenced, but do not scaffold pipeline code.
- Use actual generated assets only if the current concept calls for them and they already exist or the user provided them.
- Do not create product extension files. This is design exploration.

## Design posture

Think first. Decide what the report is trying to prove, then design around that claim.

Good report pages:

- lead with one sharp claim or verdict
- make evidence easy to scan
- distinguish report page, raw artifacts, and global ledger
- use color for meaning or atmosphere, not decoration
- have typography with intent
- work at 1920×1080 first, then degrade gracefully
- avoid being another SaaS dashboard wearing a costume

Elite designer behavior:

- Pick a lane deliberately.
- Make a new visual idea, not a remix of the last one.
- Iterate with screenshots until the composition is worth showing.
- Be ruthless about deleting awkward flourishes.
- If animation is used, keep it purposeful; static captures only prove static layout.

## Workflow

1. Read this prompt only. Optionally inspect filenames with `find` to determine next `vN`, but do not read prior HTML or captures.
2. Pick one reference bucket below. State the chosen bucket briefly.
3. Read only that bucket's listed images.
4. Ideate a new lane. Avoid all prior lanes listed in Design memory.
5. Write `docs/plans/fs-tool-research/report-design-baseline-vN.html`.
6. Use agent-browser only for static layout review:
   - set viewport to `1920 1080`
   - open the new HTML file
   - save temporary screenshots outside `design-captures`, e.g. `/tmp/tau-report-design-vN-iter-1.png`
   - read the screenshot image
   - iterate until satisfied
7. Only when satisfied, save final 16:9 capture to:
   - `docs/plans/fs-tool-research/design-captures/report-design-baseline-vN.png`
8. After final capture exists, read the final capture and update this prompt's Design memory and Generated files ledger so the next run avoids repeating the lane.
9. Run `mise run check`.
10. Report only changed paths and any important caveat.

Agent-browser commands:

```bash
npx agent-browser set viewport 1920 1080
npx agent-browser open 'file:///Users/shanepadgett/dev/open-source/tau-agent/docs/plans/fs-tool-research/report-design-baseline-vN.html'
npx agent-browser wait --load domcontentloaded
npx agent-browser screenshot /tmp/tau-report-design-vN-iter-1.png
# final only when satisfied:
npx agent-browser screenshot docs/plans/fs-tool-research/design-captures/report-design-baseline-vN.png
```

Do not use agent-browser for animation judgment unless the user explicitly asks. Static screenshots only.

## Benchmark/report content baseline

Use plausible placeholder content until real measurements exist. Keep it evidence-shaped:

- benchmark: `repo-size-profile`
- purpose: map repository file size, token mass, bucket shape, and context-pack capacity before an agent reads/edits
- corpus: Pi, Codex, OpenCode; Tau as sanity control
- threshold examples: safe read `≤8k`, range read `8–40k`, manual `40k+`, never auto `vendor/generated`
- artifacts: single-page HTML report, adjacent CSV, adjacent JSON, global research ledger
- stance: no vibe policy; measure terrain first

Avoid pretending the numbers are final. Mark sample/TBD if useful.

## Design memory: avoid repeating these lanes

These are already explored. Use them as negative space.

- V1 `report-design-baseline.html`
  - Related buckets: B evidence dashboards, E terminal/code-native.
  - Black SaaS/data-console shell. Huge warm white grotesk headline. Sparse serious copy. Quiet right card. Good seriousness; too easy to repeat as generic dark evidence UI.
- V2 `report-design-baseline-v2.html`
  - Related buckets: C editorial/research memo.
  - Cream editorial memo with fine grid, left metadata rail, black verdict card, blue italic accent. Good public memo tone; grid/paper texture is spent.
- V3 `report-design-baseline-v3.html`
  - Related buckets: B evidence dashboards, E mission-control.
  - Dark navy command deck with cyan/cream type, telemetry slab, grid/checker language. Useful density; mission-control/grid motif is overused.
- V4 `report-design-baseline-v4-revision.html`
  - Related buckets: D calm product fields, F abstract technical marks.
  - Pale mint/cream field with dark green evidence slab, contour arcs, product-field calm. Strong but do not repeat green terrain/card composition unchanged.
- V5 `report-design-baseline-v5.html`
  - Related bucket: A image-led/cinematic.
  - Cobalt luxury poster, huge cream serif, cream report artifact, black repo-atlas media plate. Strong image-led/public artifact lane; avoid royal blue + giant serif unless intentionally refining.
- V6 `report-design-baseline-v6.html`
  - Related buckets: A image-led/object-first, B evidence panels.
  - Generated dark repository terrain with alpha crystal, fading image edges, desktop-only animated SVG refraction shader, medium layout hides crystal and expands cards. Do not repeat dark terrain/crystal/object-on-landscape as the next default.
- V7 `report-design-baseline-v7.html`
  - Related bucket: F diagrams/abstract technical marks.
  - Off-white legal exhibit / industrial lab instrument: huge serif command, severe numbered findings, core-sample stacked mass print, capacity gauge, safety-orange accents. Strong calibrated evidence lane; do not repeat court-brief borders, safety stripe, or lab-gauge/card composition unchanged.

Taste notes from prior review:

- User likes elite, spacious, intentional design.
- User dislikes random dots, decorative pill tags, AI-tell dot pills, cheap glow, UI confetti, copied reference composition, and repeated grid/blueprint/checker motifs.
- Image edges must blend; hard image rectangles look bad.
- Responsive medium widths matter. If art crowds the headline, hide it and let content use the space.
- Animation should not fight object motion; shader/refraction timing should sync with physical motion.

## Generated files ledger

HTML:

- `docs/plans/fs-tool-research/report-design-baseline.html`
- `docs/plans/fs-tool-research/report-design-baseline-v2.html`
- `docs/plans/fs-tool-research/report-design-baseline-v3.html`
- `docs/plans/fs-tool-research/report-design-baseline-v4.html`
- `docs/plans/fs-tool-research/report-design-baseline-v4-revision.html`
- `docs/plans/fs-tool-research/report-design-baseline-v5.html`
- `docs/plans/fs-tool-research/report-design-baseline-v6.html`
- `docs/plans/fs-tool-research/report-design-baseline-v7.html`

Captures:

- `docs/plans/fs-tool-research/design-captures/report-design-baseline-v1.png`
- `docs/plans/fs-tool-research/design-captures/report-design-baseline-v2.png`
- `docs/plans/fs-tool-research/design-captures/report-design-baseline-v3.png`
- `docs/plans/fs-tool-research/design-captures/report-design-baseline-v4-revision-16x9.png`
- `docs/plans/fs-tool-research/design-captures/report-design-baseline-v5-16x9.png`
- `docs/plans/fs-tool-research/design-captures/report-design-baseline-v6.png`
- `docs/plans/fs-tool-research/design-captures/report-design-baseline-v7.png`

## Reference buckets

Pick one. Read only that bucket before making the design.

### A. Image-led / cinematic / object-first

Use when a real image, rendered object, video still, or illustration should be the main page event.

- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.13.19 PM.png` — Nous Portal. Royal blue field, huge serif, anime line art, luxury spacing. Image is identity.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.13.39 PM.png` — Hermes Agent. Royal blue/white, mythic illustration, giant serif headline.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.42.54 PM.png` — Citypunks. Red cinematic character poster, bold display type, gamey but strong image-as-hero.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.36.27 PM.png` — Nova mission control. Sci-fi dashboard wrapped around rocket media.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.38.08 PM.png` — Opal mobile UI. Black phone UI with opalescent central object and sharp metric colors.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.36.58 PM.png` — Pencil.dev. White/yellow/black, giant media slab, minimal geometry.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.41.22 PM.png` — BetterStack. Dark observability hero with atmospheric beam imagery.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.20.47 PM.png` — Tailwind feature cards. Images inside dark product cards.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.20.51 PM.png` — Tailwind docs/components. Photos, code, UI samples, swatches as content tiles.

### B. Evidence dashboards / benchmark-native pages

Use when credibility, measurement, and dense evidence should dominate.

- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.14.05 PM.png` — Augment Context Engine. Black/green benchmark section, charts, savings claim. Closest content fit.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.15.36 PM.png` — Factory analytics. Black/orange stacked bars and KPI cards.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.15.44 PM.png` — Factory readiness. Black/orange metrics, table, radar, line chart.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.15.19 PM.png` — Factory software-factory cards. Radar/process diagrams.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.29.06 PM.png` — Pi packages. Dark package/search/filter layout, mono labels.

### C. Editorial / article / research memo

Use when the report should read like a polished decision memo instead of a dashboard.

- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.19.20 PM.png` — Linear dark article. Calm centered title, subtle technical graphic.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.19.13 PM.png` — Linear light article. Airy prose and simple system diagram.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.18.06 PM.png` — Linear dark product section. Huge muted headline, thin line illustrations/cards.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.28.49 PM.png` — Pi site. Dark navy terminal + serif prose + grid; good tone, avoid copying grid.

### D. Calm geometric product fields

Use for premium, spacious, non-terminal systems.

- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.30.08 PM.png` — Cohere North. Pale green field, stacked dark workflow cards.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.30.15 PM.png` — Cohere North testimonial. White testimonial card plus black dotted topographic visual.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.29.38 PM.png` — Cohere Labs. Saturated blue research page, centered headline, dotted globe.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.40.08 PM.png` — Customer.io. Teal/lime hero, large soft type, geometric line art.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.40.38 PM.png` — Yellow/orange meditation UI. Huge warm arcs, minimal shapes, low data density.

### E. Terminal / mission-control / code-native

Use when operational, technical, and tool-adjacent is the goal. Avoid generic command-center cosplay.

- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.17.40 PM.png` — OpenCode. Terminal-ish dark/brown, mono, borders, utilitarian stats.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.15.53 PM.png` — Factory mission control. Black/orange terminal command center with centered product UI.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.36.27 PM.png` — Nova mission control. Blue sci-fi telemetry, mono dashboard, large media panel.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.28.49 PM.png` — Pi site. Dark navy, terminal, serif docs prose.

### F. Diagrams / abstract technical marks

Use when the page needs meaningful non-photo visuals without generated image assets.

- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.30.15 PM.png` — Black dotted topographic visual beside testimonial.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.40.08 PM.png` — Customer.io geometric line art.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.19.13 PM.png` — Linear light system diagram.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.18.06 PM.png` — Linear thin line product illustrations.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.29.38 PM.png` — Cohere dotted globe.
- `/Users/shanepadgett/Desktop/Screenshot 2026-06-20 at 1.17.40 PM.png` — OpenCode simple statistical marks.

## Good next lanes

Consider these because prior designs have not exhausted them:

- Financial newspaper / market evidence page: warm newsprint, dense tables, sharp black type, restrained deltas.
- Museum placard / evidence exhibit: stone/white field, huge artifact, severe captions, minimal color.
- Legal exhibit / court brief: monochrome plus one accent, numbered findings, exhibit tags.
- Industrial lab instrument: off-white + graphite + safety orange, calibrated physical-panel feel.
- Quiet technical atlas: abstract but meaningful maps, not grid/blueprint wallpaper.

Pick your own if better. Just make it new.
