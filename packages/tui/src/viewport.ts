export interface VisibleWindow {
	start: number;
	end: number;
}

export function clampIndex(index: number, length: number): number {
	return Math.min(Math.max(0, index), Math.max(0, length - 1));
}

export function visibleWindow(cursor: number, length: number, maxVisible: number): VisibleWindow {
	const visible = Math.max(1, maxVisible);
	const start = Math.max(0, Math.min(cursor - Math.floor(visible / 2), length - visible));
	return { start, end: Math.min(length, start + visible) };
}
