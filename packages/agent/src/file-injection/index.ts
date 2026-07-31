import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Marker } from "@shanepadgett/tau-tui";
import { BoundedTextResultBuilder, truncateBoundedHead } from "../../shared/bounded-text-result.ts";
import { createCompleteFileMeta, type ReadCacheMetaV1 } from "../../shared/full-file-knowledge.ts";
import type { TemporaryOutputStore } from "../../shared/temporary-output-store.ts";
import type { ToolRowStateStore } from "../../shared/tool-row-state.ts";
import { formatOutlineEmpty, formatOutlineFile } from "../ast/format/outline.ts";
import { outlinePath } from "../ast/queries/outline.ts";
import { formatLargeReadOutline, shouldOutlineFullRead } from "../ast/read-policy.ts";
import { astEngineFor } from "../ast/session.ts";
import { formatPathForDisplay, resolveExplorePath, stripLeadingAt } from "../ast/traverse.ts";

export const FILE_INJECTION_TYPE = "tau.file";

const OUTLINE_OPTIONS = { includePrivate: false, includeDocs: false, names: [] as readonly string[] };

/**
 * `full` always injects complete contents, `outline` always injects structure,
 * and `auto` injects contents unless the source is larger than Explore's
 * structural read threshold.
 */
export type FileInjectionMode = "full" | "outline" | "auto";

export interface FileInjectionDetails {
	v: 1;
	rowId: string;
	path: string;
	cwd: string;
	source: string;
	batchId: string;
	/** What was actually injected. `auto` resolves to `full` or `outline`. */
	kind: "full" | "outline";
	status: "injected" | "failed";
	error?: string;
	readCache?: ReadCacheMetaV1;
}

export interface PreparedFileInjection {
	customType: typeof FILE_INJECTION_TYPE;
	content: string;
	display: true;
	details: FileInjectionDetails;
}

export interface FileInjectionRequest {
	cwd: string;
	/** Caller identifier recorded on each message. */
	source: string;
	/** Groups the visible rows produced by one call. */
	batchId: string;
	files: ReadonlyArray<{ path: string; mode: FileInjectionMode }>;
	signal?: AbortSignal;
}

interface FileInjectionHost {
	temporaryOutput: TemporaryOutputStore;
	autoOutline(): { enabled: boolean; thresholdLines: number };
}

let host: FileInjectionHost | undefined;

function requireHost(): FileInjectionHost {
	if (host === undefined) throw new Error("File injection is unavailable: Explore is not loaded");
	return host;
}

/** Explore owns the parse engine settings and temporary output store this module needs. */
export function registerFileInjection(pi: ExtensionAPI, rowState: ToolRowStateStore, next: FileInjectionHost): void {
	host = next;
	pi.on("session_shutdown", () => {
		host = undefined;
	});
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

/** Builds injection messages without sending them. */
export async function prepareFileInjection(request: FileInjectionRequest): Promise<PreparedFileInjection[]> {
	const prepared: PreparedFileInjection[] = [];
	for (const [index, file] of request.files.entries()) {
		request.signal?.throwIfAborted();
		const path = stripLeadingAt(file.path);
		const base = {
			v: 1 as const,
			rowId: `${request.batchId}:${index}`,
			path,
			cwd: request.cwd,
			source: request.source,
			batchId: request.batchId,
		};
		try {
			prepared.push(await prepareOne(base, file.mode, request.signal));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (request.signal?.aborted) throw error;
			prepared.push({
				customType: FILE_INJECTION_TYPE,
				content: `${path}\nInjection failed: ${message}`,
				display: true,
				details: { ...base, kind: file.mode === "outline" ? "outline" : "full", status: "failed", error: message },
			});
		}
	}
	return prepared;
}

/** Prepares and sends injection messages in request order. */
export async function injectFiles(
	pi: Pick<ExtensionAPI, "sendMessage">,
	request: FileInjectionRequest,
): Promise<PreparedFileInjection[]> {
	const prepared = await prepareFileInjection(request);
	for (const message of prepared) pi.sendMessage(message);
	return prepared;
}

type InjectionBase = Omit<FileInjectionDetails, "kind" | "status" | "error" | "readCache">;

async function prepareOne(
	base: InjectionBase,
	mode: FileInjectionMode,
	signal: AbortSignal | undefined,
): Promise<PreparedFileInjection> {
	if (mode === "outline") return prepareOutline(base, signal);
	if (mode === "full") return prepareFull(base, signal);
	const settings = requireHost().autoOutline();
	if (!settings.enabled) return prepareFull(base, signal);
	const engine = astEngineFor(base.cwd);
	const absolutePath = resolveExplorePath(base.cwd, base.path);
	if (engine.registry.adapterForPath(absolutePath) === undefined) return prepareFull(base, signal);
	let lineCount: number;
	try {
		lineCount = (await engine.sourceForFile(absolutePath)).ir.lineCount;
	} catch {
		return prepareFull(base, signal);
	}
	if (!shouldOutlineFullRead(lineCount, settings.thresholdLines)) return prepareFull(base, signal);
	return prepareLargeSourceOutline(base, lineCount, signal);
}

async function prepareFull(base: InjectionBase, signal: AbortSignal | undefined): Promise<PreparedFileInjection> {
	const pathKey = resolve(base.cwd, base.path);
	const bytes = signal ? await readFile(pathKey, { signal }) : await readFile(pathKey);
	const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	const messageContent = `${base.path}\n${content}`;
	if (truncateBoundedHead(messageContent).truncated)
		throw new Error("File exceeds the complete injection limit; outline or read a range instead");
	const totalLines = content.split("\n").length;
	return {
		customType: FILE_INJECTION_TYPE,
		content: messageContent,
		display: true,
		details: {
			...base,
			kind: "full",
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

async function outlineFile(base: InjectionBase, signal: AbortSignal | undefined) {
	const engine = astEngineFor(base.cwd);
	const result = await outlinePath(engine, base.path, OUTLINE_OPTIONS, signal ?? new AbortController().signal);
	return { engine, file: result.mode === "file" ? result.file : undefined };
}

async function prepareOutline(base: InjectionBase, signal: AbortSignal | undefined): Promise<PreparedFileInjection> {
	const { engine, file } = await outlineFile(base, signal);
	if (!file) throw new Error("Outline injection requires a file path");
	const body =
		file.rows.length === 0 ? formatOutlineEmpty(OUTLINE_OPTIONS.names) : formatOutlineFile(file, engine.cwd, false);
	const builder = new BoundedTextResultBuilder(requireHost().temporaryOutput, "completeBlocks");
	let content: string;
	try {
		await builder.appendBlock(file.path, formatPathForDisplay(file.path, engine.cwd), `${base.path}\n${body}`);
		content = (await builder.finish()).content;
	} catch (error) {
		await builder.abort();
		throw error;
	}
	return {
		customType: FILE_INJECTION_TYPE,
		content,
		display: true,
		details: { ...base, kind: "outline", status: "injected" },
	};
}

async function prepareLargeSourceOutline(
	base: InjectionBase,
	lineCount: number,
	signal: AbortSignal | undefined,
): Promise<PreparedFileInjection> {
	const { engine, file } = await outlineFile(base, signal);
	if (!file) return prepareFull(base, signal);
	const outlineText = formatLargeReadOutline(
		file.rows.length === 0 ? "No declarations" : formatOutlineFile(file, engine.cwd, false),
	);
	const messageContent = `${base.path}\n${outlineText}`;
	return {
		customType: FILE_INJECTION_TYPE,
		content: messageContent,
		display: true,
		details: {
			...base,
			kind: "outline",
			status: "injected",
			readCache: createCompleteFileMeta({
				pathKey: resolve(base.cwd, base.path),
				presentation: "plain",
				servedHash: createHash("sha256").update(outlineText, "utf8").digest("hex"),
				mode: "baseline",
				sourceText: outlineText,
				returnedText: messageContent,
				totalLines: lineCount,
				summary: `outline (${lineCount} lines)`,
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
		(details.kind !== "full" && details.kind !== "outline") ||
		(details.status !== "injected" && details.status !== "failed")
	)
		return undefined;
	return {
		v: 1,
		rowId: details.rowId,
		path: details.path,
		cwd: details.cwd,
		source: details.source,
		batchId: details.batchId,
		kind: details.kind,
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
			label: this.details.kind === "outline" ? "outline" : "read",
			parts: [this.details.path],
		}).render(width);
		if (!this.expanded || this.details.status === "failed") return marker;
		return [...marker, ...new Text(this.theme.fg("dim", this.content), 1, 0).render(width)];
	}

	invalidate(): void {}
}
