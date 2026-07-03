import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { visibleWindow } from "./viewport.ts";

export function renderWindowedRows<T>(
	theme: Theme,
	items: readonly T[],
	cursor: number,
	maxVisible: number,
	emptyMessage: string,
	width: number,
	renderRow: (item: T, index: number) => string[],
): string[] {
	if (items.length === 0) return wrapTextWithAnsi(theme.fg("muted", emptyMessage), width);

	const lines: string[] = [];
	const { start, end } = visibleWindow(cursor, items.length, maxVisible);
	for (let index = start; index < end; index++) {
		const item = items[index];
		if (item !== undefined) lines.push(...renderRow(item, index));
	}
	if (start > 0 || end < items.length) lines.push(theme.fg("dim", `  (${cursor + 1}/${items.length})`));
	return lines;
}

export function renderPrefixedLines(
	prefix: string,
	prefixWidth: number,
	content: readonly string[],
	width: number,
): string[] {
	const indent = " ".repeat(prefixWidth);
	return content.map((line, index) => truncateToWidth(`${index === 0 ? prefix : indent}${line}`, width, ""));
}
