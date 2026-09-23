import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Editor, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export function renderInlineEditor(prefix: string, editor: Editor, width: number): string[] {
	const available = Math.max(1, width - visibleWidth(prefix));
	const lines = editorContentLines(editor.render(available));
	const contentLines = lines.length ? lines : [""];
	const continuation = " ".repeat(visibleWidth(prefix));
	return contentLines.map((line, index) =>
		truncateToWidth(`${index === 0 ? prefix : continuation}${line}`, width, ""),
	);
}

export function renderNoteEditor(lines: string[], editor: Editor, width: number, theme: Theme, indent: string): void {
	const prefix = `${indent}${theme.fg("muted", "└─ ")}`;
	const available = Math.max(1, width - visibleWidth(prefix));
	const editorLines = editorContentLines(editor.render(available));
	const contentLines = editorLines.length ? editorLines : [""];
	lines.push(truncateToWidth(`${prefix}${contentLines[0] ?? ""}`, width, ""));
	const continuation = " ".repeat(visibleWidth(prefix));
	for (const line of contentLines.slice(1)) lines.push(truncateToWidth(`${continuation}${line}`, width, ""));
}

export function pushSavedNote(lines: string[], note: string, width: number, theme: Theme, indent: string): void {
	for (const line of wrapWithPrefix(`${indent}${theme.fg("muted", "└─ ")}`, theme.fg("muted", note), width)) {
		lines.push(line);
	}
}

export function wrapWithPrefix(prefix: string, text: string, width: number): string[] {
	const restWidth = Math.max(1, width - visibleWidth(prefix));
	return wrapTextWithAnsi(text, restWidth).map(
		(line, index) => `${index === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${line}`,
	);
}

function editorContentLines(lines: string[]): string[] {
	if (lines.length <= 2) return lines;
	return lines.slice(1).filter((line) => !isEditorBorderLine(line));
}

function isEditorBorderLine(line: string): boolean {
	const text = stripAnsi(line).trim();
	return /^[┌┐└┘─]+$/.test(text) || /^─── [↑↓] \d+ more ─*$/.test(text);
}

function stripAnsi(text: string): string {
	let result = text;
	while (true) {
		const start = result.indexOf("\u001b[");
		if (start === -1) return result;
		const end = result.indexOf("m", start + 2);
		if (end === -1) return result;
		result = result.slice(0, start) + result.slice(end + 1);
	}
}
