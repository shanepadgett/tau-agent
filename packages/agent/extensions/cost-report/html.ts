import { daysInMonth } from "./range.ts";
import type { CostReport, DayCost } from "./types.ts";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function money(value: number): string {
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(value);
}

function tokens(value: number): string {
	if (value < 1000) return String(Math.round(value));
	if (value < 10_000) return `${(value / 1000).toFixed(1)}K`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}K`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

function percent(part: number, whole: number): string {
	if (whole <= 0) return "0%";
	return `${Math.round((part / whole) * 100)}%`;
}

function heatClass(amount: number): string {
	if (amount <= 0) return "bg-stone-200 dark:bg-stone-800";
	if (amount < 10) return "bg-green-600";
	if (amount < 18) return "bg-lime-500";
	if (amount < 28) return "bg-yellow-400";
	if (amount < 38) return "bg-yellow-500";
	if (amount < 45) return "bg-amber-500";
	if (amount < 50) return "bg-orange-500";
	if (amount < 100) return "bg-red-600";
	return "bg-red-700";
}

function formatGenerated(ms: number): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(ms));
}

function dayButton(day: DayCost, fill: boolean): string {
	const tip = `${escapeHtml(day.label)} · ${money(day.cost)}`;
	const fire = day.cost > 100;
	const weekend = day.weekend ? " is-weekend" : "";
	const sizeClass = fill ? "w-full" : "flex-1";
	const aria = [day.label + " · " + money(day.cost), day.weekend ? "weekend" : "", fire ? "high spend" : ""]
		.filter(Boolean)
		.join(", ");
	return `<button type="button" class="day-cell relative h-full min-w-0 ${sizeClass} rounded-sm border border-stone-900/10 dark:border-white/10 ${heatClass(day.cost)}${weekend}" role="listitem" aria-label="${escapeHtml(aria)}">${
		fire ? `<span class="day-fire" aria-hidden="true">🔥</span>` : ""
	}<span class="day-tip" aria-hidden="true">${tip}</span></button>`;
}

function shareBar(share: number): string {
	const width = Math.max(0, Math.min(100, Math.round(share * 100)));
	return `<span class="mt-1 block h-1 rounded-sm bg-stone-200 dark:bg-stone-700" aria-hidden="true"><span class="block h-full rounded-sm bg-stone-500 dark:bg-stone-400" style="width:${width}%"></span></span>`;
}

function renderDayRow(days: DayCost[]): string {
	return `<div class="flex h-10 w-full gap-1" role="list" aria-label="Spend by day">${days.map((day) => dayButton(day, false)).join("")}</div>`;
}

function renderYtd(days: DayCost[], year: number): string {
	const byMonth = new Map<number, DayCost[]>();
	for (const day of days) {
		const month = new Date(day.timestampMs).getMonth();
		const list = byMonth.get(month) ?? [];
		list.push(day);
		byMonth.set(month, list);
	}
	const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const rows: string[] = [];
	const maxMonth = Math.max(0, ...byMonth.keys());
	for (let month = 0; month <= maxMonth; month += 1) {
		const monthDays = byMonth.get(month) ?? [];
		const byDate = new Map(monthDays.map((day) => [new Date(day.timestampMs).getDate(), day]));
		const cells: string[] = [];
		const length = daysInMonth(year, month);
		for (let date = 1; date <= 31; date += 1) {
			if (date <= length) {
				const existing = byDate.get(date);
				if (existing) {
					cells.push(dayButton(existing, true));
				} else {
					const ts = new Date(year, month, date).getTime();
					cells.push(
						dayButton(
							{
								dateKey: `${year}-${String(month + 1).padStart(2, "0")}-${String(date).padStart(2, "0")}`,
								label: `${date} ${monthNames[month]}`,
								timestampMs: ts,
								cost: 0,
								weekend: new Date(ts).getDay() === 0 || new Date(ts).getDay() === 6,
							},
							true,
						),
					);
				}
			} else {
				cells.push(`<span class="min-w-0" aria-hidden="true"></span>`);
			}
		}
		rows.push(`<div class="grid grid-cols-[2.5rem_1fr] items-center gap-2" role="listitem">
			<div class="text-xs text-stone-600 dark:text-stone-400">${monthNames[month]}</div>
			<div class="day-grid-31 h-8 w-full" role="list" aria-label="${monthNames[month]} spend">${cells.join("")}</div>
		</div>`);
	}
	return `<div class="space-y-1" role="list" aria-label="Year to date spend by month">${rows.join("")}</div>`;
}

export function renderCostReportHtml(report: CostReport): string {
	const scopeLabel = report.scope === "project" ? "Current project" : "All sessions";
	const scopeClass = report.scope === "project" ? "scope-project" : "scope-all";
	const totalShare = report.totalCost;
	const tokenShareBase = report.totalTokens;
	const subagentShareBase = report.subagentCost;

	const modelRows = report.models
		.map((model) => {
			const share = tokenShareBase > 0 ? model.tokens / tokenShareBase : 0;
			return `<tr data-cost="${model.cost}" data-share="${model.tokens}">
				<td class="px-3 py-2">${escapeHtml(model.provider)} / ${escapeHtml(model.model)}</td>
				<td class="px-3 py-2 text-right">${money(model.cost)}</td>
				<td class="px-3 py-2 text-right">${tokens(model.tokens)}</td>
				<td class="px-3 py-2 text-right">${percent(model.tokens, tokenShareBase)}</td>
				<td class="px-3 py-2">${shareBar(share)}</td>
				<td class="px-3 py-2 text-right">${model.sessions}</td>
			</tr>`;
		})
		.join("");

	const subagentRows =
		report.subagents.length === 0
			? `<tr><td class="px-3 py-2 text-stone-600 dark:text-stone-400" colspan="5">No subagent spend in this window.</td></tr>`
			: report.subagents
					.map((agent) => {
						const share = subagentShareBase > 0 ? agent.cost / subagentShareBase : 0;
						return `<tr>
							<td class="px-3 py-2">${escapeHtml(agent.agent)}</td>
							<td class="px-3 py-2 text-right">${money(agent.cost)}</td>
							<td class="px-3 py-2 text-right">${percent(agent.cost, subagentShareBase)}</td>
							<td class="px-3 py-2">${shareBar(share)}</td>
							<td class="px-3 py-2 text-right">${agent.calls}</td>
						</tr>`;
					})
					.join("");

	const projectRows = report.projects
		.map((project) => {
			const share = totalShare > 0 ? project.cost / totalShare : 0;
			return `<tr data-project-key="${escapeHtml(project.key)}">
				<td class="px-3 py-2">${escapeHtml(project.label)}</td>
				<td class="px-3 py-2 text-right">${money(project.cost)}</td>
				<td class="px-3 py-2 text-right">${percent(project.cost, totalShare)}</td>
				<td class="px-3 py-2">${shareBar(share)}</td>
				<td class="px-3 py-2 text-right">${project.sessions}</td>
			</tr>`;
		})
		.join("");

	const sessionRows = report.sessions
		.map((session) => {
			const models = session.models.map((model) => `${escapeHtml(model.label)} (${money(model.cost)})`).join(", ");
			return `<tr data-project-key="${escapeHtml(session.projectKey)}">
				<td class="px-3 py-2">
					<span class="font-medium">${escapeHtml(session.name)}</span>
					<span class="mt-0.5 block text-xs text-stone-600 dark:text-stone-400">${escapeHtml(
						formatGenerated(session.startedAtMs),
					)}</span>
				</td>
				<td class="project-col px-3 py-2">${escapeHtml(session.projectLabel)}</td>
				<td class="px-3 py-2 font-mono text-xs text-stone-600 dark:text-stone-400">${models || "—"}</td>
				<td class="px-3 py-2 text-right tabular">${tokens(session.tokens)}</td>
				<td class="px-3 py-2 text-right tabular">${money(session.cost)}</td>
			</tr>`;
		})
		.join("");

	const projectOptions = [
		`<option value="">All projects</option>`,
		...report.projects.map(
			(project) => `<option value="${escapeHtml(project.key)}">${escapeHtml(project.label)}</option>`,
		),
	].join("");

	const dailyBody =
		report.range.layout === "ytd"
			? renderYtd(report.days, report.range.year ?? new Date(report.generatedAtMs).getFullYear())
			: renderDayRow(report.days);

	const dayCountLabel =
		report.range.layout === "ytd" ? `${report.days.length} days · by month` : `${report.days.length} days in range`;

	return `<!doctype html>
<html lang="en" class="h-full">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Cost report · ${escapeHtml(report.range.label)} · ${escapeHtml(scopeLabel)}</title>
	<script>
		(() => {
			const key = "tau-cost-report-theme";
			const stored = localStorage.getItem(key);
			const dark =
				stored === "dark" ||
				(stored !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
			document.documentElement.classList.toggle("dark", dark);
		})();
	</script>
	<script src="https://cdn.tailwindcss.com"></script>
	<script>
		tailwind.config = {
			darkMode: "class",
			theme: {
				extend: {
					fontFamily: {
						sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
						mono: ["ui-monospace", "SF Mono", "Menlo", "Consolas", "monospace"],
					},
				},
			},
		};
	</script>
	<style type="text/tailwindcss">
		@layer utilities {
			.tabular { font-variant-numeric: tabular-nums; }
		}
	</style>
	<style>
		body.scope-project .all-only { display: none; }
		body.scope-project .project-col { display: none; }
		.day-cell { container-type: size; }
		.day-cell .day-tip {
			position: absolute;
			bottom: calc(100% + 6px);
			left: 50%;
			z-index: 10;
			transform: translateX(-50%);
			white-space: nowrap;
			padding: 0.3rem 0.5rem;
			border-radius: 0.25rem;
			border: 1px solid rgb(214 211 209);
			background: rgb(255 255 255);
			color: rgb(28 25 23);
			font-size: 0.75rem;
			line-height: 1.25;
			pointer-events: none;
			opacity: 0;
			visibility: hidden;
		}
		.dark .day-cell .day-tip {
			border-color: rgb(68 64 60);
			background: rgb(28 25 23);
			color: rgb(245 245 244);
		}
		.day-cell:hover .day-tip,
		.day-cell:focus-visible .day-tip {
			opacity: 1;
			visibility: visible;
		}
		.day-cell .day-fire {
			position: absolute;
			inset: 0.25rem;
			display: grid;
			place-items: center;
			font-size: 80cqmin;
			line-height: 1;
			pointer-events: none;
		}
		.day-cell.is-weekend::before {
			content: "";
			position: absolute;
			inset: 0;
			border-radius: inherit;
			background: repeating-linear-gradient(-45deg, transparent 0 3px, rgb(0 0 0 / 0.14) 3px 5px);
			pointer-events: none;
		}
		.dark .day-cell.is-weekend::before {
			background: repeating-linear-gradient(-45deg, transparent 0 3px, rgb(255 255 255 / 0.16) 3px 5px);
		}
		.day-grid-31 {
			display: grid;
			grid-template-columns: repeat(31, minmax(0, 1fr));
			gap: 0.25rem;
		}
		th.sortable {
			cursor: pointer;
			user-select: none;
		}
		th.sortable:hover {
			color: rgb(28 25 23);
		}
		.dark th.sortable:hover {
			color: rgb(245 245 244);
		}
		th.sortable[aria-sort="descending"]::after {
			content: " ↓";
		}
		th.sortable[aria-sort="ascending"]::after {
			content: " ↑";
		}
	</style>
</head>
<body class="${scopeClass} min-h-full bg-stone-100 text-stone-900 antialiased dark:bg-stone-950 dark:text-stone-100">
	<main class="mx-auto w-full max-w-[90rem] px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
		<header class="mb-6 flex items-start justify-between gap-4 border-b border-stone-300 pb-4 dark:border-stone-700">
			<div>
				<h1 class="text-xl font-semibold tracking-tight">Cost report</h1>
				<p class="mt-1 text-sm text-stone-600 dark:text-stone-400">
					<span>${escapeHtml(report.range.label)}</span>
					<span class="before:mx-2 before:text-stone-400 before:content-['·'] dark:before:text-stone-600">${escapeHtml(scopeLabel)}</span>
					<span class="before:mx-2 before:text-stone-400 before:content-['·'] dark:before:text-stone-600">Generated ${escapeHtml(formatGenerated(report.generatedAtMs))}</span>
				</p>
			</div>
			<button type="button" id="theme-toggle" class="shrink-0 rounded border border-stone-300 bg-white px-2.5 py-1 text-sm text-stone-800 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-100" aria-label="Switch to dark mode">Dark</button>
		</header>

		<div class="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
			<div class="rounded border border-stone-300 bg-white px-4 py-4 text-center dark:border-stone-700 dark:bg-stone-900">
				<div class="text-3xl font-semibold tracking-tight tabular sm:text-4xl">${money(report.totalCost)}</div>
				<div class="mt-1 text-sm text-stone-600 dark:text-stone-400">Total spend</div>
			</div>
			<div class="rounded border border-stone-300 bg-white px-4 py-4 text-center dark:border-stone-700 dark:bg-stone-900">
				<div class="text-3xl font-semibold tracking-tight tabular sm:text-4xl">${report.sessionCount}</div>
				<div class="mt-1 text-sm text-stone-600 dark:text-stone-400">Sessions</div>
			</div>
			<div class="all-only rounded border border-stone-300 bg-white px-4 py-4 text-center dark:border-stone-700 dark:bg-stone-900">
				<div class="text-3xl font-semibold tracking-tight tabular sm:text-4xl">${report.projectCount}</div>
				<div class="mt-1 text-sm text-stone-600 dark:text-stone-400">Projects</div>
			</div>
			<div class="rounded border border-stone-300 bg-white px-4 py-4 text-center dark:border-stone-700 dark:bg-stone-900">
				<div class="text-3xl font-semibold tracking-tight tabular sm:text-4xl">${tokens(report.totalTokens)}</div>
				<div class="mt-1 text-sm text-stone-600 dark:text-stone-400">Tokens</div>
			</div>
		</div>

		<section class="mb-8" aria-labelledby="daily-heading">
			<div class="mb-3 flex items-baseline justify-between gap-3">
				<h2 id="daily-heading" class="text-sm font-semibold">Daily spend</h2>
				<span class="text-sm text-stone-600 dark:text-stone-400">${escapeHtml(dayCountLabel)}</span>
			</div>
			${dailyBody}
			<div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-stone-600 dark:text-stone-400" aria-hidden="true">
				<span>$0</span>
				<span class="flex gap-px">
					<span class="size-3 rounded-sm border border-stone-900/10 bg-stone-200 dark:border-white/10 dark:bg-stone-800"></span>
					<span class="size-3 rounded-sm border border-stone-900/10 bg-green-600"></span>
					<span class="size-3 rounded-sm border border-stone-900/10 bg-yellow-500"></span>
					<span class="size-3 rounded-sm border border-stone-900/10 bg-red-600"></span>
				</span>
				<span>$50+</span>
				<span>· 🔥 over $100</span>
				<span>· diagonal = weekend</span>
			</div>
		</section>

		<div class="mb-8 grid gap-8 xl:grid-cols-2 xl:items-start">
			<section aria-labelledby="models-heading">
				<h2 id="models-heading" class="mb-3 text-sm font-semibold">Models</h2>
				<div class="overflow-x-auto rounded border border-stone-300 bg-white dark:border-stone-700 dark:bg-stone-900">
					<table id="models-table" class="w-full text-sm tabular">
						<thead>
							<tr class="text-left text-xs font-medium text-stone-600 dark:text-stone-400">
								<th scope="col" class="px-3 py-2 font-medium">Model</th>
								<th scope="col" class="sortable px-3 py-2 text-right font-medium" data-sort="cost" aria-sort="none">Cost</th>
								<th scope="col" class="px-3 py-2 text-right font-medium">Tokens</th>
								<th scope="col" class="sortable px-3 py-2 text-right font-medium" data-sort="share" aria-sort="descending">Share (tok)</th>
								<th scope="col" class="min-w-[7rem] px-3 py-2 font-medium"></th>
								<th scope="col" class="px-3 py-2 text-right font-medium">Sessions</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-stone-200 dark:divide-stone-800">${modelRows || `<tr><td class="px-3 py-2 text-stone-600 dark:text-stone-400" colspan="6">No model spend.</td></tr>`}</tbody>
					</table>
				</div>
			</section>

			<section aria-labelledby="subagents-heading">
				<h2 id="subagents-heading" class="mb-3 text-sm font-semibold">Subagents</h2>
				<div class="overflow-x-auto rounded border border-stone-300 bg-white dark:border-stone-700 dark:bg-stone-900">
					<table class="w-full text-sm tabular">
						<thead>
							<tr class="text-left text-xs font-medium text-stone-600 dark:text-stone-400">
								<th scope="col" class="px-3 py-2 font-medium">Agent</th>
								<th scope="col" class="px-3 py-2 text-right font-medium">Cost</th>
								<th scope="col" class="px-3 py-2 text-right font-medium">Share</th>
								<th scope="col" class="min-w-[7rem] px-3 py-2 font-medium"></th>
								<th scope="col" class="px-3 py-2 text-right font-medium">Calls</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-stone-200 dark:divide-stone-800">${subagentRows}</tbody>
					</table>
				</div>
			</section>
		</div>

		<section class="all-only mb-8" aria-labelledby="projects-heading">
			<h2 id="projects-heading" class="mb-3 text-sm font-semibold">Projects</h2>
			<div class="overflow-x-auto rounded border border-stone-300 bg-white dark:border-stone-700 dark:bg-stone-900">
				<table class="w-full text-sm tabular">
					<thead>
						<tr class="text-left text-xs font-medium text-stone-600 dark:text-stone-400">
							<th scope="col" class="px-3 py-2 font-medium">Project</th>
							<th scope="col" class="px-3 py-2 text-right font-medium">Cost</th>
							<th scope="col" class="px-3 py-2 text-right font-medium">Share</th>
							<th scope="col" class="min-w-[7rem] px-3 py-2 font-medium"></th>
							<th scope="col" class="px-3 py-2 text-right font-medium">Sessions</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-stone-200 dark:divide-stone-800">${projectRows}</tbody>
				</table>
			</div>
		</section>

		<section class="mb-8" aria-labelledby="sessions-heading">
			<div class="mb-3 flex items-baseline justify-between gap-3">
				<h2 id="sessions-heading" class="text-sm font-semibold">Sessions</h2>
				<div class="all-only flex items-center gap-2">
					<label for="project-filter" class="text-sm text-stone-600 dark:text-stone-400">Project</label>
					<select id="project-filter" class="rounded border border-stone-300 bg-white px-2 py-1 text-sm text-stone-900 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-100">${projectOptions}</select>
				</div>
			</div>
			<div class="overflow-x-auto rounded border border-stone-300 bg-white dark:border-stone-700 dark:bg-stone-900">
				<table class="w-full text-sm">
					<thead>
						<tr class="text-left text-xs font-medium text-stone-600 dark:text-stone-400">
							<th scope="col" class="px-3 py-2 font-medium">Session</th>
							<th scope="col" class="project-col px-3 py-2 font-medium">Project</th>
							<th scope="col" class="px-3 py-2 font-medium">Models</th>
							<th scope="col" class="px-3 py-2 text-right font-medium">Tokens</th>
							<th scope="col" class="px-3 py-2 text-right font-medium">Cost</th>
						</tr>
					</thead>
					<tbody id="sessions-body" class="divide-y divide-stone-200 dark:divide-stone-800">${sessionRows || `<tr><td class="px-3 py-2 text-stone-600 dark:text-stone-400" colspan="5">No sessions.</td></tr>`}</tbody>
				</table>
			</div>
		</section>

		<footer class="mt-10 border-t border-stone-300 pt-4 text-xs text-stone-600 dark:border-stone-700 dark:text-stone-400">
			<p>
				Costs are estimates from stored session usage, not provider invoices. Branched turns count. Subagent
				totals come from parent tool results. Direct ${money(report.directCost)} · Subagents ${money(report.subagentCost)}.
			</p>
		</footer>
	</main>
	<script>
		(() => {
			const key = "tau-cost-report-theme";
			const root = document.documentElement;
			const button = document.getElementById("theme-toggle");
			if (button) {
				const sync = () => {
					const dark = root.classList.contains("dark");
					button.textContent = dark ? "Light" : "Dark";
					button.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
				};
				button.addEventListener("click", () => {
					const dark = !root.classList.contains("dark");
					root.classList.toggle("dark", dark);
					localStorage.setItem(key, dark ? "dark" : "light");
					sync();
				});
				sync();
			}

			const filter = document.getElementById("project-filter");
			const body = document.getElementById("sessions-body");
			if (filter && body) {
				filter.addEventListener("change", () => {
					const value = filter.value;
					for (const row of body.querySelectorAll("tr[data-project-key]")) {
						const key = row.getAttribute("data-project-key") || "";
						row.hidden = Boolean(value) && key !== value;
					}
				});
			}

			const modelsTable = document.getElementById("models-table");
			if (modelsTable) {
				const tbody = modelsTable.querySelector("tbody");
				const headers = modelsTable.querySelectorAll("th.sortable");
				if (tbody && headers.length > 0) {
					let active = "share";
					let direction = "desc";
					const sortRows = () => {
						const rows = [...tbody.querySelectorAll("tr[data-cost]")];
						rows.sort((a, b) => {
							const attr = "data-" + active;
							const av = Number(a.getAttribute(attr)) || 0;
							const bv = Number(b.getAttribute(attr)) || 0;
							return direction === "desc" ? bv - av : av - bv;
						});
						for (const row of rows) tbody.appendChild(row);
						for (const header of headers) {
							const key = header.getAttribute("data-sort") || "";
							header.setAttribute(
								"aria-sort",
								key === active ? (direction === "desc" ? "descending" : "ascending") : "none",
							);
						}
					};
					for (const header of headers) {
						header.tabIndex = 0;
						const activate = () => {
							const key = header.getAttribute("data-sort") || "";
							if (key === active) {
								direction = direction === "desc" ? "asc" : "desc";
							} else {
								active = key;
								direction = "desc";
							}
							sortRows();
						};
						header.addEventListener("click", activate);
						header.addEventListener("keydown", (event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								activate();
							}
						});
					}
				}
			}
		})();
	</script>
</body>
</html>`;
}
