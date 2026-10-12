import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { keyText, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Marker } from "@shanepadgett/tau-tui";
import { truncateBoundedHead } from "../../shared/bounded-text-result.ts";
import { createCompleteFileMeta, type ReadCacheMetaV1 } from "../../shared/full-file-knowledge.ts";
import type { ToolRowStateStore } from "../../shared/tool-row-state.ts";

export const FILE_INJECTION_TYPE = "tau.file";

const FILE_RENDER_CHARACTERS = 20_000;
const FILE_RENDER_LINES = 200;

export interface FileInjectionDetails {
	v: 1;
	rowId: string;
	path: string;
	cwd: string;
	source: string;
	batchId: string;
	status: "injected" | "failed";
	error?: string;
	readCache?: ReadCacheMetaV1;
}

export interface PreparedFileInjection {
	customType: typeof FILE_INJECTION_TYPE;
	content: string;
	display: boolean;
	details: FileInjectionDetails;
}

export interface FileInjectionRequest {
	cwd: string;
	/** Caller label stored on each row, such as `handoff`. */
	source: string;
	/** Shared id for rows prepared together; row ids are `<batchId>:<index>`. */
	batchId: string;
	paths: ReadonlyArray<string>;
}

type InjectionBase = Omit<FileInjectionDetails, "status" | "error" | "readCache">;

export function registerFileInjectionRenderer(pi: ExtensionAPI, rowState: ToolRowStateStore): void {
	pi.registerMessageRenderer<FileInjectionDetails>(FILE_INJECTION_TYPE, (message, options, theme) => {
		const details = parseDetails(message.details);
		if (!details) return undefined;
		return new FileInjectionComponent(
			rowState,
			details,
			typeof message.content === "string" ? message.content : "",
			options.expanded,
			theme,
		);
	});
}

/** Reads complete files into injection messages without sending them. */
export async function prepareFileInjection(request: FileInjectionRequest): Promise<PreparedFileInjection[]> {
	const prepared: PreparedFileInjection[] = [];
	for (const [index, path] of request.paths.entries()) {
		const base: InjectionBase = {
			v: 1,
			rowId: `${request.batchId}:${index}`,
			path: path.startsWith("@") ? path.slice(1) : path,
			cwd: request.cwd,
			source: request.source,
			batchId: request.batchId,
		};
		try {
			prepared.push(await prepareFull(base));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			prepared.push({
				customType: FILE_INJECTION_TYPE,
				content: `${base.path}\nInjection failed: ${message}`,
				display: true,
				details: { ...base, status: "failed", error: message },
			});
		}
	}
	return prepared;
}

async function prepareFull(base: InjectionBase): Promise<PreparedFileInjection> {
	const pathKey = resolve(base.cwd, base.path);
	const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(pathKey));
	const messageContent = `${base.path}\n${content}`;
	if (truncateBoundedHead(messageContent).truncated) throw new Error("File exceeds the complete injection limit");
	const totalLines = content.split("\n").length;
	return {
		customType: FILE_INJECTION_TYPE,
		content: messageContent,
		display: true,
		details: {
			...base,
			status: "injected",
			readCache: createCompleteFileMeta({
				pathKey,
				presentation: "plain",
				servedHash: createHash("sha256").update(content, "utf8").digest("hex"),
				mode: "baseline",
				sourceText: content,
				returnedText: messageContent,
				totalLines,
				summary: `${totalLines} lines`,
			}),
		},
	};
}

function parseDetails(value: unknown): FileInjectionDetails | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const details = value as Record<string, unknown>;
	if (
		details.v !== 1 ||
		typeof details.rowId !== "string" ||
		typeof details.path !== "string" ||
		typeof details.cwd !== "string" ||
		typeof details.source !== "string" ||
		typeof details.batchId !== "string" ||
		(details.status !== "injected" && details.status !== "failed")
	) {
		return undefined;
	}
	return {
		v: 1,
		rowId: details.rowId,
		path: details.path,
		cwd: details.cwd,
		source: details.source,
		batchId: details.batchId,
		status: details.status,
		...(typeof details.error === "string" ? { error: details.error } : {}),
	};
}

class FileInjectionComponent {
	private readonly rowState: ToolRowStateStore;
	private readonly details: FileInjectionDetails;
	private readonly content: string;
	private readonly expanded: boolean;
	private readonly theme: Theme;

	constructor(
		rowState: ToolRowStateStore,
		details: FileInjectionDetails,
		content: string,
		expanded: boolean,
		theme: Theme,
	) {
		this.rowState = rowState;
		this.details = details;
		this.content = content;
		this.expanded = expanded;
		this.theme = theme;
		this.rowState.watch(details.rowId, () => this.invalidate());
	}

	render(width: number): string[] {
		const state =
			this.details.status === "failed"
				? "error"
				: this.rowState.get(this.details.rowId) === "pruned"
					? "warning"
					: "complete";
		const marker = new Marker({
			theme: this.theme,
			state,
			label: "read",
			parts: [this.details.path],
		}).render(width);
		if (!this.expanded || this.details.status === "failed") {
			if (this.details.status === "failed") return marker;
			const hint = this.theme.fg("muted", `(${keyText("app.tools.expand")} to expand)`);
			const last = marker.length - 1;
			return marker.map((line, index) => (index === last ? truncateToWidth(`${line} ${hint}`, width, "…") : line));
		}

		const bounded =
			this.content.length > FILE_RENDER_CHARACTERS
				? `${this.content.slice(0, FILE_RENDER_CHARACTERS)}\n…`
				: this.content;
		const content = wrapTextWithAnsi(this.theme.fg("dim", bounded), Math.max(1, width - 1))
			.slice(0, FILE_RENDER_LINES)
			.map((line) => truncateToWidth(` ${line}`, width, "…"));
		return [...marker, ...content];
	}

	invalidate(): void {}
}
