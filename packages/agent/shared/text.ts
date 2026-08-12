import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";

// Small text helpers shared across extensions.

export { formatAge, preview } from "@shanepadgett/tau-tui";

const TOOL_OUTPUT_PREVIEW_LINES = 10;

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function truncAt(text: string, cap: number): string {
	return text.length > cap ? `${text.slice(0, cap)}\n(truncated)` : text;
}

export function renderToolOutputPreview(text: string, expanded: boolean, theme: Theme): string {
	const lines = text.split("\n");
	while (lines.at(-1) === "") lines.pop();

	const totalLines = lines.length;
	const displayLines = expanded ? lines : lines.slice(0, TOOL_OUTPUT_PREVIEW_LINES);
	const remaining = totalLines - displayLines.length;
	const output = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (remaining <= 0) return output;

	return (
		`${output}${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ` +
		keyHint("app.tools.expand", "to expand") +
		theme.fg("muted", ")")
	);
}
