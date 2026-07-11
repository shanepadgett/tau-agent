import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderToolKeyHints, type ToolKeyHint } from "./key-hints.ts";

export type ToolPanelFooter =
	| { kind: "hints"; hints: readonly ToolKeyHint[] }
	| { kind: "destructiveAck"; message: string; hints: readonly ToolKeyHint[] }
	| { kind: "infoAck"; message: string; hints: readonly ToolKeyHint[] };

export interface ToolPanelConfig {
	title: string;
	secondary?: string;
	header?: Component | readonly string[];
	body: Component;
	footer: ToolPanelFooter;
}

export class ToolPanel implements Component {
	private readonly theme: Theme;
	private config: ToolPanelConfig;

	constructor(theme: Theme, config: ToolPanelConfig) {
		this.theme = theme;
		this.config = config;
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const body = this.config.body.render(renderWidth).map((line) => truncateToWidth(line, renderWidth, ""));
		const footer = this.renderFooter(renderWidth);
		const lines: string[] = [];

		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));
		lines.push(...this.renderTitle(renderWidth));
		const header = this.renderHeader(renderWidth);
		if (header.length > 0) lines.push("");
		lines.push(...header);
		if (body.length > 0) lines.push("");
		lines.push(...body);
		if (footer.length > 0) lines.push("");
		lines.push(...footer);
		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));

		return lines;
	}

	invalidate(): void {
		const header = this.config.header;
		if (header && "render" in header) header.invalidate();
		this.config.body.invalidate();
	}

	private renderTitle(width: number): string[] {
		const title = this.theme.fg("accent", this.theme.bold(this.config.title));
		const lines = [truncateToWidth(title, width, "")];
		if (this.config.secondary) {
			lines.push(
				...wrapTextWithAnsi(this.theme.fg("dim", this.config.secondary), width).map((line) =>
					truncateToWidth(line, width, ""),
				),
			);
		}
		return lines;
	}

	private renderHeader(width: number): string[] {
		const header = this.config.header;
		if (!header) return [];

		if ("render" in header) {
			return header.render(width).map((line) => truncateToWidth(line, width, ""));
		}

		return header.flatMap((line) =>
			wrapTextWithAnsi(line, width).map((wrapped) => truncateToWidth(wrapped, width, "")),
		);
	}

	private renderFooter(width: number): string[] {
		const footer = this.config.footer;
		const hintText = renderToolKeyHints(this.theme, footer.hints);
		const text =
			footer.kind === "hints"
				? hintText
				: `${this.theme.fg(footer.kind === "destructiveAck" ? "error" : "accent", footer.message)}  ${hintText}`;

		if (!text) return [];
		return wrapTextWithAnsi(text, width).map((line) => truncateToWidth(line, width, ""));
	}
}
