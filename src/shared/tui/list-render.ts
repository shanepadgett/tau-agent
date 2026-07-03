import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { visibleWindow } from "./viewport.ts";

export function renderWindowedList<T>(
	theme: Theme,
	items: readonly T[],
	cursor: number,
	maxVisible: number,
	emptyMessage: string,
	width: number,
	renderHeader: (width: number) => readonly string[],
	renderRow: (item: T, index: number, width: number) => string[],
): string[] {
	const renderWidth = Math.max(1, width);
	return [
		...renderHeader(renderWidth),
		...renderWindowedRows(theme, items, cursor, maxVisible, emptyMessage, renderWidth, (item, index) =>
			renderRow(item, index, renderWidth),
		),
	];
}

export function renderPrefixedRow<T, S>(
	item: T,
	state: S,
	width: number,
	prefix: string,
	prefixWidthText: string,
	renderItem: (item: T, state: S, width: number) => string[],
): string[] {
	const prefixWidth = visibleWidth(prefixWidthText);
	const content = renderItem(item, state, Math.max(1, width - prefixWidth));
	return renderPrefixedLines(prefix, prefixWidth, content, width);
}

function renderWindowedRows<T>(
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

function renderPrefixedLines(prefix: string, prefixWidth: number, content: readonly string[], width: number): string[] {
	const indent = " ".repeat(prefixWidth);
	return content.map((line, index) => truncateToWidth(`${index === 0 ? prefix : indent}${line}`, width, ""));
}
