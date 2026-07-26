import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { onTauEvent, type TauAgentEvents } from "../../shared/events.js";
import type { ToolRowStateStore } from "../../shared/tool-row-state.js";
import { Marker, type MarkerState } from "@shanepadgett/tau-tui";
import { createCompleteFileMeta } from "./full-file-knowledge.ts";
import type { ReadCacheMetaV1 } from "./read-cache.ts";

const AUTOREAD_MESSAGE_TYPE = "tau.autoread";

type AutoreadStatus = "reading" | "read" | "failed";

export interface AutoreadDetails {
	rowId: string;
	path: string;
	cwd: string;
	source: string;
	batchId: string;
	status: AutoreadStatus;
	error?: string;
	readCache?: ReadCacheMetaV1;
}

export interface PreparedAutoreadMessage {
	customType: typeof AUTOREAD_MESSAGE_TYPE;
	content: string;
	display: true;
	details: AutoreadDetails & { status: "read"; readCache: ReadCacheMetaV1 };
}

export async function prepareAutoreadMessage(options: {
	rowId: string;
	path: string;
	cwd: string;
	source: string;
	batchId: string;
	signal: AbortSignal | undefined;
	isLifecycleCurrent: () => boolean;
	maximumBytes?: number;
}): Promise<PreparedAutoreadMessage> {
	assertPreparationCurrent(options.signal, options.isLifecycleCurrent);
	const pathKey = resolve(options.cwd, options.path);
	const bytes = options.signal ? await readFile(pathKey, { signal: options.signal }) : await readFile(pathKey);
	if (options.maximumBytes !== undefined && bytes.byteLength > options.maximumBytes) {
		throw new Error(`File exceeds the ${options.maximumBytes}-byte complete-file snapshot limit`);
	}
	const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	const messageContent = `${options.path}\n${content}`;
	const totalLines = content.split("\n").length;
	const readCache = createCompleteFileMeta({
		pathKey,
		presentation: "plain",
		servedHash: createHash("sha256").update(content, "utf8").digest("hex"),
		mode: "baseline",
		sourceText: content,
		returnedText: messageContent,
		totalLines,
		summary: `${totalLines} lines`,
	}) satisfies ReadCacheMetaV1;
	assertPreparationCurrent(options.signal, options.isLifecycleCurrent);
	return {
		customType: AUTOREAD_MESSAGE_TYPE,
		content: messageContent,
		display: true,
		details: {
			rowId: options.rowId,
			path: options.path,
			cwd: options.cwd,
			source: options.source,
			batchId: options.batchId,
			status: "read",
			readCache,
		},
	};
}

export function registerAutoread(pi: ExtensionAPI, rowState: ToolRowStateStore): void {
	let lifecycleGeneration = 0;
	pi.on("session_start", () => {
		lifecycleGeneration += 1;
	});
	pi.on("session_compact", () => {
		lifecycleGeneration += 1;
	});
	pi.on("session_tree", () => {
		lifecycleGeneration += 1;
	});
	pi.on("session_shutdown", () => {
		lifecycleGeneration += 1;
	});
	onTauEvent(pi, "explore.autoread", "tau:autoread.requested", async (data) => {
		const event = readAutoreadRequestedEvent(data);
		if (!event) return;
		const generation = lifecycleGeneration;
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
					const message = await prepareAutoreadMessage({
						...details,
						signal: undefined,
						isLifecycleCurrent: () => generation === lifecycleGeneration,
					});
					pi.sendMessage(message);
				} catch (error) {
					if (generation !== lifecycleGeneration) return;
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

	pi.registerMessageRenderer<AutoreadDetails>(AUTOREAD_MESSAGE_TYPE, (message, _options, theme) => {
		const details = readDetails(message.details);
		if (!details) return undefined;
		return new AutoreadMessageComponent(rowState, details.rowId, details.path, details.status, theme);
	});
}

function assertPreparationCurrent(signal: AbortSignal | undefined, isLifecycleCurrent: () => boolean): void {
	signal?.throwIfAborted();
	if (!isLifecycleCurrent()) throw new Error("Autoread preparation crossed a session lifecycle boundary");
}

function readAutoreadRequestedEvent(value: unknown): TauAgentEvents["tau:autoread.requested"] | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.source !== "string") return undefined;
	if (typeof record.cwd !== "string") return undefined;
	if (typeof record.batchId !== "string") return undefined;
	if (record.title !== undefined && typeof record.title !== "string") return undefined;
	if (!Array.isArray(record.files)) return undefined;
	const files: Array<{ path: string }> = [];
	for (const file of record.files) {
		if (!file || typeof file !== "object") return undefined;
		const path = (file as Record<string, unknown>).path;
		if (typeof path !== "string") return undefined;
		files.push({ path });
	}

	return {
		source: record.source,
		...(record.title === undefined ? {} : { title: record.title }),
		cwd: record.cwd,
		batchId: record.batchId,
		files,
	};
}

function readDetails(value: unknown): AutoreadDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.rowId !== "string") return undefined;
	if (typeof record.path !== "string") return undefined;
	if (typeof record.cwd !== "string") return undefined;
	if (typeof record.source !== "string") return undefined;
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
	private readonly theme: Theme;

	constructor(rowState: ToolRowStateStore, rowId: string, path: string, status: AutoreadStatus, theme: Theme) {
		this.rowState = rowState;
		this.rowId = rowId;
		this.path = path;
		this.status = status;
		this.theme = theme;
		this.rowState.watch(this.rowId, () => this.invalidate());
	}

	render(width: number): string[] {
		return new Marker({
			theme: this.theme,
			state: this.markerState(),
			label: "autoread",
			parts: [this.path],
		}).render(width);
	}

	invalidate(): void {
		// Rendering is stateless; this watcher gives the owning custom-message row
		// the invalidation signal needed to redraw after a row-state snapshot.
	}

	private markerState(): MarkerState {
		if (this.rowState.get(this.rowId) === "pruned") return "warning";
		if (this.status === "failed") return "error";
		return this.status === "reading" ? "busy" : "complete";
	}
}
