export type ReadyStatus = "pass" | "weak" | "missing" | "na" | "unknown";
export type ReadyHow = "scan" | "judgment" | "mixed";
export type ReadyFormat = "markdown" | "html";

export type ReadyAreaId =
	| "cold-start"
	| "toolchain"
	| "verify"
	| "lint-entropy"
	| "policy"
	| "standards"
	| "context"
	| "reuse"
	| "markers"
	| "harness"
	| "side-effect-verbs";

export interface ReadyRow {
	id: string;
	area: ReadyAreaId;
	title: string;
	status: ReadyStatus;
	how: ReadyHow;
	evidence: string[];
	note: string;
	next?: string;
}

export interface ReadyReport {
	generatedAt: string;
	generatedAtLabel: string;
	root: string;
	languages: string[];
	rows: ReadyRow[];
	counts: Record<ReadyStatus, number>;
}

export const AREA_LABELS: Record<ReadyAreaId, string> = {
	"cold-start": "Cold start",
	toolchain: "Toolchain",
	verify: "Verify",
	"lint-entropy": "Lint and entropy",
	policy: "Policy",
	standards: "Standards",
	context: "Context",
	reuse: "Reuse",
	markers: "Markers",
	harness: "Harness gates",
	"side-effect-verbs": "Side-effect verbs",
};

export const AREA_ORDER: ReadyAreaId[] = [
	"cold-start",
	"toolchain",
	"verify",
	"lint-entropy",
	"policy",
	"standards",
	"context",
	"reuse",
	"markers",
	"harness",
	"side-effect-verbs",
];

export function countStatuses(rows: readonly ReadyRow[]): Record<ReadyStatus, number> {
	const counts: Record<ReadyStatus, number> = {
		pass: 0,
		weak: 0,
		missing: 0,
		na: 0,
		unknown: 0,
	};
	for (const row of rows) counts[row.status] += 1;
	return counts;
}

export function summarizeCounts(counts: Record<ReadyStatus, number>): string {
	const parts: string[] = [];
	for (const status of ["pass", "weak", "missing", "na", "unknown"] as const) {
		if (counts[status] > 0) parts.push(`${counts[status]} ${status}`);
	}
	return parts.join(" · ") || "no rows";
}

/** Local-timezone stamp for filenames: 2026-04-08-143052 */
export function localTimestampSlug(date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
		"-",
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
	].join("");
}

export function localTimestampLabel(date = new Date()): string {
	return date.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "short",
	});
}

export function row(
	partial: Omit<ReadyRow, "how" | "evidence"> & {
		how?: ReadyHow;
		evidence?: string[];
	},
): ReadyRow {
	return {
		how: partial.how ?? "scan",
		evidence: partial.evidence ?? [],
		id: partial.id,
		area: partial.area,
		title: partial.title,
		status: partial.status,
		note: partial.note,
		next: partial.next,
	};
}
