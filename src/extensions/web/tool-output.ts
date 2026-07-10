import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type AgentToolResult,
	type Theme,
	type ToolRenderResultOptions,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

export function truncateToolOutput(text: string): { text: string; truncation?: TruncationResult } {
	const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncation.truncated) return { text: truncation.content };

	return {
		text:
			truncation.content +
			`\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
			`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`,
		truncation,
	};
}

export function truncateCallSummary(text: string): string {
	return text.length <= 90 ? text : `${text.slice(0, 89)}…`;
}

export function renderWebToolResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: { lastComponent: Component | undefined },
): Text {
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const firstText = result.content.find((item) => item.type === "text");

	if (options.isPartial) {
		text.setText("");
		return text;
	}
	if (!options.expanded || firstText?.type !== "text") {
		text.setText("");
		return text;
	}

	const output = firstText.text
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");
	text.setText(output ? `\n${output}` : "");
	return text;
}
