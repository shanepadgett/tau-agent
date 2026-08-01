import {
	AREA_LABELS,
	AREA_ORDER,
	type ReadyFormat,
	type ReadyReport,
	type ReadyRow,
	type ReadyStatus,
	summarizeCounts,
} from "./model.ts";

const STATUS_ORDER: ReadyStatus[] = ["missing", "weak", "unknown", "pass", "na"];

export function renderReadyReport(report: ReadyReport, format: ReadyFormat): string {
	return format === "html" ? renderHtml(report) : renderMarkdown(report);
}

export function readyFileExtension(format: ReadyFormat): "md" | "html" {
	return format === "html" ? "html" : "md";
}

function rowsByArea(report: ReadyReport): Map<string, ReadyRow[]> {
	const map = new Map<string, ReadyRow[]>();
	for (const area of AREA_ORDER) map.set(area, []);
	for (const item of report.rows) {
		const list = map.get(item.area) ?? [];
		list.push(item);
		map.set(item.area, list);
	}
	for (const list of map.values()) {
		list.sort(
			(a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.title.localeCompare(b.title),
		);
	}
	return map;
}

function renderMarkdown(report: ReadyReport): string {
	const lines: string[] = [
		"# Agent readiness report",
		"",
		`- Generated: ${report.generatedAtLabel}`,
		`- Root: \`${report.root}\``,
		`- Languages: ${report.languages.length > 0 ? report.languages.join(", ") : "none detected"}`,
		`- Summary: ${summarizeCounts(report.counts)}`,
		"",
		"Scan-only. No scores. Status is presence/heuristic evidence, not prose quality.",
		"",
	];

	const byArea = rowsByArea(report);
	for (const area of AREA_ORDER) {
		const rows = byArea.get(area) ?? [];
		if (rows.length === 0) continue;
		lines.push(`## ${AREA_LABELS[area]}`, "");
		for (const item of rows) {
			lines.push(`### ${statusGlyph(item.status)} ${item.title}`, "");
			lines.push(`- Status: **${item.status}** (${item.how})`);
			lines.push(`- ${item.note}`);
			if (item.evidence.length > 0) {
				lines.push("- Evidence:");
				for (const evidence of item.evidence) lines.push(`  - \`${evidence}\``);
			}
			if (item.next) lines.push(`- Next: ${item.next}`);
			lines.push("");
		}
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

function renderHtml(report: ReadyReport): string {
	const byArea = rowsByArea(report);
	const sections: string[] = [];
	for (const area of AREA_ORDER) {
		const rows = byArea.get(area) ?? [];
		if (rows.length === 0) continue;
		const items = rows.map((item) => renderHtmlRow(item)).join("\n");
		sections.push(`
<details class="area" open>
  <summary><h2>${escapeHtml(AREA_LABELS[area])}</h2></summary>
  <div class="rows">${items}</div>
</details>`);
	}

	const lang = report.languages.length > 0 ? escapeHtml(report.languages.join(", ")) : "none detected";
	const summary = STATUS_ORDER.filter((status) => report.counts[status] > 0)
		.map((status) => `<span class="count ${status}">${status} ${report.counts[status]}</span>`)
		.join("");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Agent readiness</title>
<script>
(() => {
  const key = "ready-theme";
  const stored = localStorage.getItem(key);
  const theme =
    stored === "light" || stored === "dark"
      ? stored
      : window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  document.documentElement.dataset.theme = theme;
})();
</script>
<style>
:root {
  --pass: #4cc38a;
  --weak: #f0b429;
  --missing: #f2555a;
  --na: #6b7280;
  --unknown: #a78bfa;
  --font: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
html[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0c0c0d;
  --text: #ebebeb;
  --muted: #8a8f98;
  --faint: #5c6370;
  --line: #2a2b2f;
}
html[data-theme="light"] {
  color-scheme: light;
  --bg: #ffffff;
  --text: #1a1a1a;
  --muted: #6b6f76;
  --faint: #9b9fa8;
  --line: #e6e6e6;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
main {
  max-width: 720px;
  margin: 0 auto;
  padding: 4rem 1.5rem 6rem;
}
header {
  margin-bottom: 3.5rem;
}
h1 {
  margin: 0 0 1.25rem;
  font-size: 1.375rem;
  font-weight: 560;
  letter-spacing: -0.02em;
  line-height: 1.2;
}
.meta {
  display: grid;
  gap: 0.35rem;
  color: var(--muted);
  font-size: 0.8125rem;
}
.meta span.label {
  color: var(--faint);
  display: inline-block;
  min-width: 5.5rem;
}
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem 1.5rem;
  margin-top: 1.5rem;
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
}
.count { color: var(--muted); }
.count.pass { color: var(--pass); }
.count.weak { color: var(--weak); }
.count.missing { color: var(--missing); }
.count.na { color: var(--na); }
.count.unknown { color: var(--unknown); }
.area { margin: 0 0 3.5rem; }
.area > summary {
  list-style: none;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding-bottom: 0.75rem;
  margin-bottom: 1.5rem;
  border-bottom: 1px solid var(--line);
}
.area > summary::-webkit-details-marker { display: none; }
.area > summary::before {
  content: "";
  width: 0.4rem;
  height: 0.4rem;
  border-right: 1.5px solid var(--muted);
  border-bottom: 1.5px solid var(--muted);
  transform: rotate(45deg);
  transition: transform 120ms ease;
  flex-shrink: 0;
}
.area[open] > summary::before {
  transform: rotate(225deg);
  translate: 0 0.1rem;
}
.area h2 {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 560;
  letter-spacing: -0.015em;
  color: var(--text);
}
.rows {
  display: grid;
  gap: 1.75rem;
}
.row { padding: 0; }
.row-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}
.row h3 {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 510;
  letter-spacing: -0.01em;
}
.status {
  flex-shrink: 0;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: lowercase;
}
.status.pass { color: var(--pass); }
.status.weak { color: var(--weak); }
.status.missing { color: var(--missing); }
.status.na { color: var(--na); }
.status.unknown { color: var(--unknown); }
.note {
  margin: 0.4rem 0 0;
  color: var(--muted);
  font-size: 0.875rem;
  max-width: 58ch;
}
.evidence {
  margin: 0.65rem 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.25rem;
}
.evidence li {
  color: var(--faint);
  font-size: 0.75rem;
  font-family: var(--mono);
  line-height: 1.4;
}
.next {
  margin: 0.7rem 0 0;
  color: var(--text);
  font-size: 0.8125rem;
}
.next span.label {
  color: var(--faint);
  margin-right: 0.35rem;
}
code {
  font-family: var(--mono);
  font-size: 0.9em;
}
.dock {
  position: fixed;
  right: 1.25rem;
  bottom: 1.25rem;
  display: flex;
  gap: 0.5rem;
  z-index: 20;
}
.dock button,
.theme-toggle {
  appearance: none;
  margin: 0;
  border: 1px solid var(--line);
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 999px;
  display: grid;
  place-items: center;
  background: var(--bg);
  color: var(--muted);
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
.dock button:hover,
.theme-toggle:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--bg) 88%, var(--text));
}
.dock button:focus-visible,
.theme-toggle:focus-visible {
  outline: 1px solid var(--text);
  outline-offset: 2px;
}
.dock svg,
.theme-toggle svg {
  width: 1.05rem;
  height: 1.05rem;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.theme-toggle {
  position: fixed;
  top: 1.25rem;
  right: 1.25rem;
  z-index: 20;
}
html[data-theme="dark"] .theme-toggle .icon-moon { display: none; }
html[data-theme="light"] .theme-toggle .icon-sun { display: none; }
</style>
</head>
<body>
<button type="button" class="theme-toggle" id="theme-toggle" title="Toggle theme" aria-label="Toggle theme">
  <svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="4"/>
    <path d="M12 2v2"/>
    <path d="M12 20v2"/>
    <path d="m4.93 4.93 1.41 1.41"/>
    <path d="m17.66 17.66 1.41 1.41"/>
    <path d="M2 12h2"/>
    <path d="M20 12h2"/>
    <path d="m6.34 17.66-1.41 1.41"/>
    <path d="m19.07 4.93-1.41 1.41"/>
  </svg>
  <svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
  </svg>
</button>
<main>
<header>
  <h1>Agent readiness</h1>
  <div class="meta">
    <div><span class="label">Generated</span>${escapeHtml(report.generatedAtLabel)}</div>
    <div><span class="label">Root</span><code>${escapeHtml(report.root)}</code></div>
    <div><span class="label">Languages</span>${lang}</div>
  </div>
  <div class="summary">${summary}</div>
</header>
${sections.join("\n")}
</main>
<div class="dock" role="group" aria-label="Sections">
  <button type="button" id="expand-all" title="Expand all" aria-label="Expand all">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 15 5 5 5-5"/>
      <path d="m7 9 5-5 5 5"/>
    </svg>
  </button>
  <button type="button" id="collapse-all" title="Collapse all" aria-label="Collapse all">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 20 5-5 5 5"/>
      <path d="m7 4 5 5 5-5"/>
    </svg>
  </button>
</div>
<script>
(() => {
  const sections = () => document.querySelectorAll("details.area");
  document.getElementById("expand-all")?.addEventListener("click", () => {
    for (const el of sections()) el.open = true;
  });
  document.getElementById("collapse-all")?.addEventListener("click", () => {
    for (const el of sections()) el.open = false;
  });

  const root = document.documentElement;
  const key = "ready-theme";
  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    const next = root.dataset.theme === "light" ? "dark" : "light";
    root.dataset.theme = next;
    localStorage.setItem(key, next);
  });
})();
</script>
</body>
</html>
`;
}

function renderHtmlRow(item: ReadyRow): string {
	const evidence =
		item.evidence.length === 0
			? ""
			: `<ul class="evidence">${item.evidence.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul>`;
	const next = item.next ? `<p class="next"><span class="label">Next</span>${escapeHtml(item.next)}</p>` : "";
	return `<article class="row">
  <div class="row-head">
    <h3>${escapeHtml(item.title)}</h3>
    <span class="status ${item.status}">${item.status}</span>
  </div>
  <p class="note">${escapeHtml(item.note)}</p>
  ${evidence}
  ${next}
</article>`;
}

function statusGlyph(status: ReadyStatus): string {
	switch (status) {
		case "pass":
			return "[pass]";
		case "weak":
			return "[weak]";
		case "missing":
			return "[missing]";
		case "na":
			return "[n/a]";
		case "unknown":
			return "[?]";
	}
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
