import { formatSize, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { formatToolRowTitle, type ToolRowStateStore } from "../../../shared/tool-row-state.ts";
import { renderToolOutputPreview } from "../../../shared/text.ts";

export type ExploreToolDetails = {
	declarationCount: number;
	returnedBytes: number;
	truncated: boolean;
};

/**
 * TUI title width fallbacks for a list: full join, progressively shorter with `,+N`, then summary.
 * Callers wrap each variant with path/option chrome as needed.
 */
export function shrinkingListVariants(items: readonly string[], summary: string, empty = ""): string[] {
	if (items.length === 0) return [empty];
	const variants: string[] = [];
	for (let shown = items.length; shown >= 1; shown -= 1) {
		const omitted = items.length - shown;
		const head = items.slice(0, shown).join(",");
		variants.push(omitted > 0 ? `${head},+${omitted}` : head);
	}
	variants.push(summary);
	return variants;
}

/** Compact call row: `tool → target [options]` with left-truncating target variants. */
export class ExploreCallComponent implements Component {
	private readonly rowState: ToolRowStateStore;
	private readonly rowId: string;
	private readonly tool: string;
	targetVariants: string[];
	optionVariants: string[];
	theme: Theme;

	constructor(
		rowState: ToolRowStateStore,
		rowId: string,
		tool: string,
		targetVariants: string[],
		optionVariants: string[],
		theme: Theme,
	) {
		this.rowState = rowState;
		this.rowId = rowId;
		this.tool = tool;
		this.targetVariants = targetVariants;
		this.optionVariants = optionVariants;
		this.theme = theme;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const prefixWidth = visibleWidth(`${this.tool} → `);
		const shortestTarget = this.targetVariants.at(-1) ?? "";
		const minimumTargetWidth = Math.min(12, visibleWidth(shortestTarget));
		const options =
			this.optionVariants.find(
				(candidate) => prefixWidth + minimumTargetWidth + (candidate ? visibleWidth(candidate) + 1 : 0) <= width,
			) ??
			this.optionVariants.at(-1) ??
			"";
		const optionsWidth = options ? visibleWidth(options) + 1 : 0;
		const targetWidth = Math.max(1, width - prefixWidth - optionsWidth);
		const target = this.targetVariants.find((candidate) => visibleWidth(candidate) <= targetWidth) ?? shortestTarget;
		const displayTarget = truncateLeft(target, targetWidth);
		const line =
			formatToolRowTitle(this.rowState, this.rowId, this.tool, this.theme) +
			this.theme.fg("toolOutput", " → ") +
			this.theme.fg("accent", displayTarget) +
			(options ? ` ${this.theme.fg("muted", options)}` : "");
		return [truncateToWidth(line, width, "")];
	}

	invalidate(): void {}
}

function truncateLeft(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width === 1) return "…";
	let suffix = "";
	for (const character of Array.from(text).reverse()) {
		if (visibleWidth(`…${character}${suffix}`) > width) break;
		suffix = character + suffix;
	}
	return `…${suffix}`;
}

export function renderExploreResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ExploreToolDetails },
	expanded: boolean,
	theme: Theme,
	context: { lastComponent?: Component; isError: boolean },
): Text {
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const output = result.content
		.filter((item): item is { type: string; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
	if (!expanded && !context.isError) {
		const count = result.details?.declarationCount ?? 0;
		const noun = count === 1 ? "declaration" : "declarations";
		const bytes = result.details === undefined ? "" : `, ${formatSize(result.details.returnedBytes)} returned`;
		const summary = theme.fg("muted", `${count} ${noun}${bytes}`);
		const preview = renderToolOutputPreview(output, false, theme);
		text.setText(
			preview ? `${summary}\n${preview}` : `${summary} (` + keyHint("app.tools.expand", "to expand") + ")",
		);
		return text;
	}
	text.setText(renderToolOutputPreview(output, true, theme));
	return text;
}
