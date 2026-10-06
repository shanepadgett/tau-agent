import { type AgentToolResult, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { renderToolOutputPreview } from "../../shared/text.ts";

export function truncateCallSummary(text: string): string {
	return text.length <= 90 ? text : `${text.slice(0, 89)}…`;
}

export function renderWebToolResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: { lastComponent: Component | undefined; isError: boolean },
): Text {
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const firstText = result.content.find((item) => item.type === "text");

	if (options.isPartial) {
		text.setText("");
		return text;
	}
	if (firstText?.type !== "text") {
		text.setText("");
		return text;
	}

	const output = renderToolOutputPreview(firstText.text, options.expanded || context.isError, theme);
	text.setText(output ? `\n${output}` : "");
	return text;
}
