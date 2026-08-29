import type { LiveRangeKind, ReportRange } from "./types.ts";

const MONTH_LABELS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;

export const LIVE_RANGE_CHOICES: ReadonlyArray<{ id: LiveRangeKind | "specific-month"; label: string }> = [
	{ id: "past-7-days", label: "Past 7 days" },
	{ id: "current-week", label: "Current week" },
	{ id: "current-month", label: "Current month" },
	{ id: "year-to-date", label: "Year to date" },
	{ id: "specific-month", label: "Specific month…" },
];

export const MONTH_CHOICES: ReadonlyArray<{ month: number; label: string }> = MONTH_LABELS.map((label, month) => ({
	month,
	label,
}));

export function yearChoices(now = new Date()): number[] {
	const current = now.getFullYear();
	return Array.from({ length: 6 }, (_, index) => current - index);
}

export function liveRange(kind: LiveRangeKind, now = new Date()): ReportRange {
	const endMs = now.getTime();
	if (kind === "past-7-days") {
		const start = startOfLocalDay(now);
		start.setDate(start.getDate() - 6);
		// Slides daily; slug pins the window end day so same-day reopens match.
		return {
			kind,
			label: "Past 7 days",
			slug: `7d-${localDateKey(endMs)}`,
			startMs: start.getTime(),
			endMs,
			layout: "row",
		};
	}
	if (kind === "current-week") {
		const start = startOfLocalDay(now);
		const day = start.getDay(); // 0 Sun … 6 Sat
		const mondayOffset = day === 0 ? -6 : 1 - day;
		start.setDate(start.getDate() + mondayOffset);
		return {
			kind,
			label: "Current week",
			slug: `week-${localDateKey(start.getTime())}`,
			startMs: start.getTime(),
			endMs,
			layout: "row",
		};
	}
	if (kind === "current-month") {
		const start = new Date(now.getFullYear(), now.getMonth(), 1);
		const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
		return {
			kind,
			label: "Current month",
			slug: `month-${ym}`,
			startMs: start.getTime(),
			endMs,
			layout: "row",
			year: now.getFullYear(),
			month: now.getMonth(),
		};
	}
	const start = new Date(now.getFullYear(), 0, 1);
	return {
		kind,
		label: "Year to date",
		slug: `ytd-${now.getFullYear()}`,
		startMs: start.getTime(),
		endMs,
		layout: "ytd",
		year: now.getFullYear(),
	};
}

export function specificMonthRange(year: number, month: number, now = new Date()): ReportRange {
	const start = new Date(year, month, 1);
	const endExclusive = new Date(year, month + 1, 1);
	const endMs = Math.min(now.getTime(), endExclusive.getTime() - 1);
	const monthLabel = MONTH_LABELS[month] ?? `Month ${month + 1}`;
	const ym = `${year}-${String(month + 1).padStart(2, "0")}`;
	return {
		kind: "specific-month",
		label: `${monthLabel} ${year}`,
		slug: ym,
		startMs: start.getTime(),
		endMs,
		layout: "row",
		year,
		month,
	};
}

export function startOfLocalDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function localDateKey(timestampMs: number): string {
	const date = new Date(timestampMs);
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

export function shortDateLabel(timestampMs: number): string {
	const date = new Date(timestampMs);
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return `${date.getDate()} ${months[date.getMonth()]}`;
}

export function isWeekend(timestampMs: number): boolean {
	const day = new Date(timestampMs).getDay();
	return day === 0 || day === 6;
}

export function eachLocalDay(startMs: number, endMs: number): number[] {
	const days: number[] = [];
	const cursor = startOfLocalDay(new Date(startMs));
	const end = startOfLocalDay(new Date(endMs));
	while (cursor.getTime() <= end.getTime()) {
		days.push(cursor.getTime());
		cursor.setDate(cursor.getDate() + 1);
	}
	return days;
}

export function daysInMonth(year: number, month: number): number {
	return new Date(year, month + 1, 0).getDate();
}
