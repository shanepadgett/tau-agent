import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { keyText, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Marker } from "@shanepadgett/tau-tui";
import { BoundedTextResultBuilder, truncateBoundedHead } from "../../shared/bounded-text-result.ts";
import { emitTauEvent, onTauEvent } from "../../shared/events.ts";
import { createCompleteFileMeta, type ReadCacheMetaV1 } from "../../shared/full-file-knowledge.ts";
import type { LineRange } from "../../shared/ranges.ts";
import type { TemporaryOutputStore } from "../../shared/temporary-output-store.ts";
import type { ToolRowStateStore } from "../../shared/tool-row-state.ts";
import { formatOutlineEmpty, formatOutlineFile } from "../ast/format/outline.ts";
import { outlinePath } from "../ast/queries/outline.ts";
import { showTargets, type ShowView } from "../ast/queries/show.ts";
import { formatLargeReadOutline, shouldOutlineFullRead } from "../ast/read-policy.ts";
import { astEngineFor } from "../ast/session.ts";
import { formatPathForDisplay, resolveExplorePath, stripLeadingAt } from "../ast/traverse.ts";

export const FILE_INJECTION_TYPE = "tau.file";

const OUTLINE_OPTIONS = { includePrivate: false, includeDocs: false, names: [] as readonly string[] };
const FILE_RENDER_CHARACTERS = 20_000;
const FILE_RENDER_LINES = 200;

/**
 * `full` always injects complete contents, `outline` always injects structure,
 * `show` injects one resolved declaration slice, and `auto` injects contents
 * unless the source is larger than Explore's structural read threshold.
 */
export type FileInjectionMode = "full" | "outline" | "auto" | "show";

export interface FileInjectionDetails {
	v: 1;
	rowId: string;
	path: string;
	cwd: string;
	source: string;
	batchId: string;
	/** One-based, inclusive ranges used for a partial file read or show slice. */
	ranges?: ReadonlyArray<LineRange>;
	/** Declaration name when kind is show. */
	showName?: string;
	/** Extract view when kind is show. */
	showView?: ShowView;
	/** What was actually injected. `auto` resolves to `full` or `outline`. */
	kind: "full" | "outline" | "show";
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

export interface FileInjectionFile {
	path: string;
	mode: FileInjectionMode;
	/** One-based, inclusive line ranges. Ranges take precedence over `auto` outlining. */
	ranges?: ReadonlyArray<LineRange>;
	/** Declaration name for mode `show`; may be dotted (`Type.method`). */
	name?: string;
	/** Show extract view; defaults to `declaration`. */
	view?: ShowView;
}

export interface FileInjectionRequest {
	cwd: string;
	/** Caller identifier recorded on each message. */
	source: string;
	/** Groups the visible rows produced by one call. */
	batchId: string;
	files: ReadonlyArray<FileInjectionFile>;
	signal?: AbortSignal;
}

interface FileInjectionHost {
	temporaryOutput: TemporaryOutputStore;
	autoOutline(): { enabled: boolean; thresholdLines: number };
}

function requireHost(host: FileInjectionHost | undefined): FileInjectionHost {
	if (host === undefined) throw new Error("File injection is unavailable: Explore is not loaded");
	return host;
}

/** Explore owns the parse engine settings and temporary output store this module needs. */
export function registerFileInjection(pi: ExtensionAPI, rowState: ToolRowStateStore, next: FileInjectionHost): void {
	onTauEvent(pi, "explore.file-injection", "tau:file-injection.prepare", ({ request, accept }) => {
		accept(prepareFileInjectionWithHost(request, next));
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
export async function prepareFileInjection(
	pi: Pick<ExtensionAPI, "events">,
	request: FileInjectionRequest,
): Promise<PreparedFileInjection[]> {
	let accepted: Promise<PreparedFileInjection[]> | undefined;
	emitTauEvent(pi, "tau:file-injection.prepare", {
		request,
		accept(preparation) {
			accepted ??= preparation;
		},
	});
	return accepted ?? prepareFileInjectionWithHost(request, undefined);
}

type InjectionBase = Omit<FileInjectionDetails, "kind" | "status" | "error" | "readCache">;
type InjectionKind = FileInjectionDetails["kind"];

function injectionKind(mode: FileInjectionMode): InjectionKind {
	if (mode === "outline") return "outline";
	if (mode === "show") return "show";
	return "full";
}

function buildInjectionBase(request: FileInjectionRequest, index: number, file: FileInjectionFile): InjectionBase {
	const ranges = file.ranges === undefined ? undefined : normalizeLineRanges(file.ranges);
	return {
		v: 1,
		rowId: `${request.batchId}:${index}`,
		path: stripLeadingAt(file.path),
		cwd: request.cwd,
		source: request.source,
		batchId: request.batchId,
		...(ranges === undefined ? {} : { ranges }),
		...(file.mode === "show" && file.name !== undefined ? { showName: file.name } : {}),
		...(file.mode === "show" ? { showView: file.view ?? "declaration" } : {}),
	};
}

function failedPreparedInjection(base: InjectionBase, kind: InjectionKind, message: string): PreparedFileInjection {
	return {
		customType: FILE_INJECTION_TYPE,
		content: `${base.path}\nInjection failed: ${message}`,
		display: true,
		details: {
			...base,
			kind,
			status: "failed",
			error: message,
		},
	};
}

async function prepareFileInjectionWithHost(
	request: FileInjectionRequest,
	host: FileInjectionHost | undefined,
): Promise<PreparedFileInjection[]> {
	const prepared: PreparedFileInjection[] = [];
	for (const [index, file] of request.files.entries()) {
		request.signal?.throwIfAborted();
		let base: InjectionBase = {
			v: 1,
			rowId: `${request.batchId}:${index}`,
			path: stripLeadingAt(file.path),
			cwd: request.cwd,
			source: request.source,
			batchId: request.batchId,
		};
		try {
			base = buildInjectionBase(request, index, file);
			prepared.push(await prepareOne(base, file, request.signal, host));
		} catch (error) {
			if (request.signal?.aborted) throw error;
			const message = error instanceof Error ? error.message : String(error);
			prepared.push(failedPreparedInjection(base, injectionKind(file.mode), message));
		}
	}
	return prepared;
}

async function prepareOne(
	base: InjectionBase,
	file: FileInjectionFile,
	signal: AbortSignal | undefined,
	host: FileInjectionHost | undefined,
): Promise<PreparedFileInjection> {
	if (file.mode === "show") {
		if (base.ranges !== undefined) throw new Error("Line ranges are not supported for show injection");
		const name = file.name?.trim();
		if (!name) throw new Error("Show injection requires a declaration name");
		return prepareShow(base, name, file.view ?? "declaration", signal);
	}
	if (base.ranges !== undefined) {
		if (file.mode === "outline") throw new Error("Line ranges are supported only for file reads");
		return prepareRangedRead(base, signal);
	}
	if (file.mode === "outline") return prepareOutline(base, signal, requireHost(host));
	if (file.mode === "full") return prepareFull(base, signal);
	const settings = requireHost(host).autoOutline();
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

async function prepareShow(
	base: InjectionBase,
	name: string,
	view: ShowView,
	signal: AbortSignal | undefined,
): Promise<PreparedFileInjection> {
	const engine = astEngineFor(base.cwd);
	const abort = signal ?? new AbortController().signal;
	const batch = await showTargets(engine, [{ path: base.path, name }], view, undefined, abort);
	const block = batch.blocks[0];
	if (block === undefined) throw new Error(`No declaration matched ${name} @ ${base.path}`);
	const rangeLabel =
		block.startLine === block.endLine ? `L${block.startLine}` : `L${block.startLine}-${block.endLine}`;
	const messageContent = [
		base.path,
		`${rangeLabel}: ${block.name}`,
		...block.warnings.map((warning) => `warning: ${warning}`),
		block.text,
	].join("\n");
	if (truncateBoundedHead(messageContent).truncated)
		throw new Error("Show target exceeds the complete injection limit; request a narrower symbol");
	return {
		customType: FILE_INJECTION_TYPE,
		content: messageContent,
		display: true,
		details: {
			...base,
			kind: "show",
			status: "injected",
			showName: block.name,
			showView: view,
			ranges: [{ startLine: block.startLine, endLine: block.endLine }],
		},
	};
}

async function prepareRangedRead(base: InjectionBase, signal: AbortSignal | undefined): Promise<PreparedFileInjection> {
	const ranges = base.ranges;
	if (ranges === undefined) throw new Error("Ranged injection requires line ranges");
	const pathKey = resolve(base.cwd, base.path);
	const bytes = signal ? await readFile(pathKey, { signal }) : await readFile(pathKey);
	const sourceText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	const lines = sourceText.split("\n");
	const selectedLines = ranges.flatMap((range) => {
		if (range.startLine > lines.length) return [];
		return lines.slice(range.startLine - 1, Math.min(range.endLine, lines.length));
	});
	if (selectedLines.length === 0) throw new Error("Line range starts beyond end of file");
	const selectedText = selectedLines.join("\n");
	const messageContent = `${base.path}\n${selectedText}`;
	if (truncateBoundedHead(messageContent).truncated)
		throw new Error("File range exceeds the complete injection limit; request a smaller range");
	return {
		customType: FILE_INJECTION_TYPE,
		content: messageContent,
		display: true,
		details: { ...base, kind: "full", status: "injected" },
	};
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

async function prepareOutline(
	base: InjectionBase,
	signal: AbortSignal | undefined,
	host: FileInjectionHost,
): Promise<PreparedFileInjection> {
	const { engine, file } = await outlineFile(base, signal);
	if (!file) throw new Error("Outline injection requires a file path");
	const body =
		file.rows.length === 0 ? formatOutlineEmpty(OUTLINE_OPTIONS.names) : formatOutlineFile(file, engine.cwd, false);
	const builder = new BoundedTextResultBuilder(host.temporaryOutput, "completeBlocks");
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

function isInjectionKind(value: unknown): value is InjectionKind {
	return value === "full" || value === "outline" || value === "show";
}

function isInjectionStatus(value: unknown): value is FileInjectionDetails["status"] {
	return value === "injected" || value === "failed";
}

function isShowView(value: unknown): value is ShowView {
	return (
		value === "signature" ||
		value === "signatureWithDocs" ||
		value === "declaration" ||
		value === "declarationWithImports"
	);
}

function parseRequiredBase(details: Record<string, unknown>): InjectionBase | undefined {
	if (
		details.v !== 1 ||
		typeof details.rowId !== "string" ||
		typeof details.path !== "string" ||
		typeof details.cwd !== "string" ||
		typeof details.source !== "string" ||
		typeof details.batchId !== "string"
	) {
		return undefined;
	}
	const ranges = details.ranges === undefined ? undefined : parseRanges(details.ranges);
	if (details.ranges !== undefined && ranges === undefined) return undefined;
	return {
		v: 1,
		rowId: details.rowId,
		path: details.path,
		cwd: details.cwd,
		source: details.source,
		batchId: details.batchId,
		...(ranges === undefined ? {} : { ranges }),
	};
}

function parseDetails(value: unknown): FileInjectionDetails | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const details = value as Record<string, unknown>;
	const base = parseRequiredBase(details);
	if (!base || !isInjectionKind(details.kind) || !isInjectionStatus(details.status)) return undefined;
	if (details.kind === "show") {
		if (typeof details.showName !== "string" || details.showName.length === 0) return undefined;
		if (!isShowView(details.showView)) return undefined;
		return {
			...base,
			showName: details.showName,
			showView: details.showView,
			kind: "show",
			status: details.status,
			...(typeof details.error === "string" ? { error: details.error } : {}),
		};
	}
	return {
		...base,
		kind: details.kind,
		status: details.status,
		...(typeof details.error === "string" ? { error: details.error } : {}),
	};
}

function normalizeLineRanges(ranges: ReadonlyArray<LineRange>): LineRange[] {
	if (ranges.length === 0) throw new Error("At least one line range is required");
	const sorted = ranges
		.map((range) => {
			if (
				!Number.isSafeInteger(range.startLine) ||
				!Number.isSafeInteger(range.endLine) ||
				range.startLine < 1 ||
				range.endLine < range.startLine
			)
				throw new Error("Line ranges must use positive, ordered line numbers");
			return { startLine: range.startLine, endLine: range.endLine };
		})
		.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
	const normalized: LineRange[] = [];
	for (const range of sorted) {
		const previous = normalized[normalized.length - 1];
		if (previous && range.startLine <= previous.endLine + 1) {
			previous.endLine = Math.max(previous.endLine, range.endLine);
		} else {
			normalized.push(range);
		}
	}
	return normalized;
}

function parseRanges(value: unknown): LineRange[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const ranges: LineRange[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
		const range = item as Record<string, unknown>;
		const startLine = range.startLine;
		const endLine = range.endLine;
		if (
			typeof startLine !== "number" ||
			typeof endLine !== "number" ||
			!Number.isSafeInteger(startLine) ||
			!Number.isSafeInteger(endLine) ||
			startLine < 1 ||
			endLine < startLine
		)
			return undefined;
		ranges.push({ startLine, endLine });
	}
	return ranges;
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
			label: this.details.kind === "outline" ? "outline" : this.details.kind === "show" ? "show" : "read",
			parts:
				this.details.kind === "show" && this.details.showName
					? [`${this.details.showName} · ${this.details.path}`]
					: [this.details.path],
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
