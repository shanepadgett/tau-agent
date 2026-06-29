import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { onTauEvent } from "../../shared/events.js";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";

const AUTOREAD_MESSAGE_TYPE = "tau.autoread";

type AutoreadStatus = "reading" | "read" | "failed";

interface AutoreadDetails {
	rowId: string;
	path: string;
	cwd: string;
	source: "tau-context";
	batchId: string;
	status: AutoreadStatus;
	error?: string;
}

export function registerAutoread(pi: ExtensionAPI, rowState: ToolRowStateStore): void {
	onTauEvent(pi, "tau:autoread.requested", async (event) => {
		await Promise.all(
			event.files.map(async (file, index) => {
				const rowId = `${event.batchId}:${index}`;
				const details = {
					rowId,
					path: file.path,
					cwd: event.cwd,
					source: event.source,
					batchId: event.batchId,
				} satisfies Omit<AutoreadDetails, "status" | "error">;
				try {
					const content = await readFile(join(event.cwd, file.path), "utf8");
					pi.sendMessage({
						customType: AUTOREAD_MESSAGE_TYPE,
						content: `${file.path}\n${content}`,
						display: true,
						details: { ...details, status: "read" },
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					pi.sendMessage({
						customType: AUTOREAD_MESSAGE_TYPE,
						content: `${file.path}\nAutoread failed: ${message}`,
						display: true,
						details: { ...details, status: "failed", error: message },
					});
				}
			}),
		);
	});

	pi.registerMessageRenderer<AutoreadDetails>(AUTOREAD_MESSAGE_TYPE, (message, options, theme) => {
		const details = readDetails(message.details);
		if (!details) return undefined;
		return new AutoreadMessageComponent(
			rowState,
			details.rowId,
			details.path,
			details.status,
			message.content,
			options.expanded,
			theme,
		);
	});
}

function readDetails(value: unknown): AutoreadDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.rowId !== "string") return undefined;
	if (typeof record.path !== "string") return undefined;
	if (typeof record.cwd !== "string") return undefined;
	if (record.source !== "tau-context") return undefined;
	if (typeof record.batchId !== "string") return undefined;
	if (record.status !== "reading" && record.status !== "read" && record.status !== "failed") return undefined;
	return {
		rowId: record.rowId,
		path: record.path,
		cwd: record.cwd,
		source: record.source,
		batchId: record.batchId,
		status: record.status,
		...(typeof record.error === "string" ? { error: record.error } : {}),
	};
}

class AutoreadMessageComponent {
	private readonly rowState: ToolRowStateStore;
	private readonly rowId: string;
	private readonly path: string;
	private readonly status: AutoreadStatus;
	private readonly content: unknown;
	private readonly expanded: boolean;
	private readonly theme: Theme;

	constructor(
		rowState: ToolRowStateStore,
		rowId: string,
		path: string,
		status: AutoreadStatus,
		content: unknown,
		expanded: boolean,
		theme: Theme,
	) {
		this.rowState = rowState;
		this.rowId = rowId;
		this.path = path;
		this.status = status;
		this.content = content;
		this.expanded = expanded;
		this.theme = theme;
	}

	render(width: number): string[] {
		const dotColor = this.status === "reading" ? "dim" : "success";
		const title = formatToolRowTitle(this.rowState, this.rowId, "autoread", this.theme);
		const row = [` ${this.theme.fg(dotColor, "●")}`, title, this.theme.fg("muted", this.path)].join(" ");
		const lines = [truncateToWidth(row, width)];
		if (this.expanded && typeof this.content === "string") lines.push(this.theme.fg("muted", this.content));
		return lines;
	}

	invalidate(): void {}
}
