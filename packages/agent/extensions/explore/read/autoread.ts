import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { prepareAutoreadMessage, registerAutoread, type PreparedAutoreadMessage } from "../../../shared/autoread.ts";
import { createCompleteFileMeta } from "../../../shared/full-file-knowledge.ts";
import { loadTauExtensionSettings } from "../../../shared/settings/load.ts";
import type { ToolRowStateStore } from "../../../shared/tool-row-state.ts";
import type { ExploreEngine } from "../ast/engine.ts";
import { formatOutlineFile } from "../ast/format/outline.ts";
import { formatLargeReadOutline, shouldOutlineFullRead, type ExploreReadSettings } from "../ast/read/policy.ts";
import { outlinePath } from "../ast/queries/outline.ts";
import exploreSettings from "../settings.ts";
import { resolveExplorePath } from "../traverse.ts";

const DEFAULT_OUTLINE_OPTIONS = {
	includePrivate: false,
	includeDocs: false,
	names: [] as readonly string[],
};

export function registerExploreAutoread(
	pi: ExtensionAPI,
	rowState: ToolRowStateStore,
	engineFor: (cwd: string) => ExploreEngine,
): void {
	let readSettings: ExploreReadSettings = exploreSettings.defaults.read;

	pi.on("session_start", async (_event, ctx) => {
		const settings = await loadTauExtensionSettings(ctx, exploreSettings);
		readSettings = settings.read;
	});

	registerAutoread(pi, rowState, async (options) => {
		return prepareExploreAutoreadMessage({
			...options,
			engine: engineFor(options.cwd),
			readSettings,
		});
	});
}

async function prepareExploreAutoreadMessage(options: {
	rowId: string;
	path: string;
	cwd: string;
	source: string;
	batchId: string;
	signal: AbortSignal | undefined;
	isLifecycleCurrent: () => boolean;
	maximumBytes?: number;
	engine: ExploreEngine;
	readSettings: ExploreReadSettings;
}): Promise<PreparedAutoreadMessage> {
	const { engine, readSettings, ...shared } = options;
	if (!readSettings.enabled) return prepareAutoreadMessage(shared);

	const absolutePath = resolveExplorePath(options.cwd, options.path);
	if (engine.registry.adapterForPath(absolutePath) === undefined) {
		return prepareAutoreadMessage(shared);
	}

	assertPreparationCurrent(options.signal, options.isLifecycleCurrent);

	let lineCount: number;
	try {
		const source = await engine.sourceForFile(absolutePath);
		lineCount = source.ir.lineCount;
	} catch {
		return prepareAutoreadMessage(shared);
	}

	if (!shouldOutlineFullRead(lineCount, readSettings.structureThresholdLines)) {
		return prepareAutoreadMessage(shared);
	}

	const abort = options.signal ?? new AbortController().signal;
	const result = await outlinePath(engine, options.path, DEFAULT_OUTLINE_OPTIONS, abort);
	assertPreparationCurrent(options.signal, options.isLifecycleCurrent);
	if (result.mode !== "file") {
		return prepareAutoreadMessage(shared);
	}

	const outlineBody =
		result.file.rows.length === 0 ? "No declarations" : formatOutlineFile(result.file, engine.cwd, false);
	const outlineText = formatLargeReadOutline(outlineBody);
	const messageContent = `${options.path}\n${outlineText}`;
	const pathKey = resolve(options.cwd, options.path);
	const readCache = createCompleteFileMeta({
		pathKey,
		presentation: "plain",
		servedHash: createHash("sha256").update(outlineText, "utf8").digest("hex"),
		mode: "baseline",
		sourceText: outlineText,
		returnedText: messageContent,
		totalLines: lineCount,
		summary: `outline (${lineCount} lines)`,
	});

	return {
		customType: "tau.autoread",
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

function assertPreparationCurrent(signal: AbortSignal | undefined, isLifecycleCurrent: () => boolean): void {
	signal?.throwIfAborted();
	if (!isLifecycleCurrent()) throw new Error("Autoread preparation crossed a session lifecycle boundary");
}
