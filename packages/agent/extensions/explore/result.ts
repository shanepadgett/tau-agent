import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export interface ExploreTextDetails {
	humanText?: string;
}

export function createExploreTextResult(
	agentText: string,
	humanText?: string,
): AgentToolResult<ExploreTextDetails | undefined> {
	return {
		content: [{ type: "text", text: agentText }],
		details: humanText !== undefined && humanText !== agentText ? { humanText } : undefined,
	};
}

export function firstTextContent(result: { content: readonly { type: string; text?: string }[] }): string {
	for (const item of result.content) {
		if (item.type === "text" && typeof item.text === "string") return item.text;
	}
	return "";
}

export function expandedExploreText(result: {
	content: readonly { type: string; text?: string }[];
	details?: ExploreTextDetails;
}): string {
	return result.details?.humanText ?? firstTextContent(result);
}
