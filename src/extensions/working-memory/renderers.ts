import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	PATH_UPDATE_CUSTOM_TYPE,
	type PathUpdateDetails,
	REREAD_CUSTOM_TYPE,
	type RereadDetails,
	textContent,
} from "./memory-messages.ts";

export type EvidenceStatus = "superseded" | "stale" | "forgotten";

export interface WorkingMemoryRenderState {
	readStatuses: Map<string, EvidenceStatus>;
	grepStatuses: Map<string, EvidenceStatus>;
	setReadStatuses(statuses: Map<string, EvidenceStatus>): void;
	setGrepStatuses(statuses: Map<string, EvidenceStatus>): void;
}

export function createWorkingMemoryRenderState(): WorkingMemoryRenderState {
	return {
		readStatuses: new Map(),
		grepStatuses: new Map(),
		setReadStatuses(statuses) {
			this.readStatuses = statuses;
		},
		setGrepStatuses(statuses) {
			this.grepStatuses = statuses;
		},
	};
}

export function registerWorkingMemoryRenderers(pi: ExtensionAPI, _renderState: WorkingMemoryRenderState): void {
	pi.registerMessageRenderer<RereadDetails>(
		REREAD_CUSTOM_TYPE,
		(message, { expanded }, theme) => new MemoryMessageComponent("reread", message, expanded, theme),
	);
	pi.registerMessageRenderer<PathUpdateDetails>(
		PATH_UPDATE_CUSTOM_TYPE,
		(message, { expanded }, theme) => new MemoryMessageComponent("path update", message, expanded, theme),
	);
}

export class ReadCallComponent implements Component {
	private readonly args: { path?: unknown; offset?: unknown; limit?: unknown };
	private readonly theme: Theme;
	private readonly toolCallId: string;
	private readonly renderState: WorkingMemoryRenderState;

	constructor(
		args: { path?: unknown; offset?: unknown; limit?: unknown },
		theme: Theme,
		toolCallId: string,
		renderState: WorkingMemoryRenderState,
	) {
		this.args = args;
		this.theme = theme;
		this.toolCallId = toolCallId;
		this.renderState = renderState;
	}

	render(): string[] {
		const path = typeof this.args.path === "string" ? this.args.path : "";
		const status = this.renderState.readStatuses.get(this.toolCallId);
		return [
			`${toolHeader(this.theme, "read")} ${this.theme.fg("muted", path)}${formatReadArgs(this.args)}${formatStatus(this.theme, status)}`,
		];
	}

	invalidate(): void {}
}

export class GrepCallComponent implements Component {
	private readonly args: { pattern?: unknown; path?: unknown; glob?: unknown; limit?: unknown };
	private readonly theme: Theme;
	private readonly toolCallId: string;
	private readonly renderState: WorkingMemoryRenderState;

	constructor(
		args: { pattern?: unknown; path?: unknown; glob?: unknown; limit?: unknown },
		theme: Theme,
		toolCallId: string,
		renderState: WorkingMemoryRenderState,
	) {
		this.args = args;
		this.theme = theme;
		this.toolCallId = toolCallId;
		this.renderState = renderState;
	}

	render(): string[] {
		const pattern = typeof this.args.pattern === "string" ? this.args.pattern : "";
		const path = typeof this.args.path === "string" && this.args.path ? this.args.path : ".";
		const glob = typeof this.args.glob === "string" && this.args.glob ? ` ${this.args.glob}` : "";
		const limit = typeof this.args.limit === "number" ? ` limit=${this.args.limit}` : "";
		const status = this.renderState.grepStatuses.get(this.toolCallId);
		return [
			`${toolHeader(this.theme, "grep")} ${this.theme.fg("accent", `/${pattern}/`)} ${this.theme.fg("muted", path)}${this.theme.fg("muted", glob)}${this.theme.fg("muted", limit)}${formatStatus(this.theme, status)}`,
		];
	}

	invalidate(): void {}
}

class MemoryMessageComponent implements Component {
	private readonly fallbackTitle: string;
	private readonly message: { content: unknown; details?: RereadDetails | PathUpdateDetails };
	private readonly expanded: boolean;
	private readonly theme: Theme;

	constructor(
		fallbackTitle: string,
		message: { content: unknown; details?: RereadDetails | PathUpdateDetails },
		expanded: boolean,
		theme: Theme,
	) {
		this.fallbackTitle = fallbackTitle;
		this.message = message;
		this.expanded = expanded;
		this.theme = theme;
	}

	render(): string[] {
		const wm = this.message.details?.workingMemory;
		const path = wm?.type === "reread" ? ` ${wm.path}` : "";
		const source = wm ? ` [${wm.source}]` : "";
		const header = `${toolHeader(this.theme, this.fallbackTitle)}${this.theme.fg("muted", path)}${this.theme.fg("muted", source)}`;
		if (!this.expanded) return [header];
		return `${header}\n${textContent(this.message.content) ?? ""}`.split("\n");
	}

	invalidate(): void {}
}

function toolHeader(theme: Theme, name: string): string {
	return theme.fg("toolTitle", theme.bold(name));
}

function formatReadArgs(args: { offset?: unknown; limit?: unknown }): string {
	const parts: string[] = [];
	if (typeof args.offset === "number") parts.push(`offset=${args.offset}`);
	if (typeof args.limit === "number") parts.push(`limit=${args.limit}`);
	return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function formatStatus(theme: Theme, status: EvidenceStatus | undefined): string {
	return status ? ` ${theme.fg("muted", `[${status}]`)}` : "";
}
