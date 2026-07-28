import type { ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { loadTauExtensionSettings } from "../../../../shared/settings/load.ts";
import exploreSettings from "../../settings.ts";
import { resolveExplorePath } from "../../traverse.ts";
import type { ExploreEngine } from "../engine.ts";
import { formatOutlineFile } from "../format/outline.ts";
import { outlinePath } from "../queries/outline.ts";
import { formatLargeReadOutline, readCallKind, shouldOutlineFullRead, type ExploreReadSettings } from "./policy.ts";

type ReadOverlayResult = {
	content: Array<{ type: "text"; text: string }>;
	details: ReadToolDetails;
	isError: boolean;
};

const DEFAULT_OUTLINE_OPTIONS = {
	includePrivate: false,
	includeDocs: false,
	names: [] as readonly string[],
};

export function registerReadOutlineHook(pi: ExtensionAPI, engineFor: (cwd: string) => ExploreEngine): void {
	let readSettings: ExploreReadSettings = exploreSettings.defaults.read;

	pi.on("session_start", async (_event, ctx) => {
		const settings = await loadTauExtensionSettings(ctx, exploreSettings);
		readSettings = settings.read;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read") return;
		if (event.isError) return;
		if (!readSettings.enabled) return;
		if (event.content.some((part) => part.type === "image")) return;

		const path = readPathInput(event.input);
		if (path === undefined) return;

		const engine = engineFor(ctx.cwd);
		const absolutePath = resolveExplorePath(engine.cwd, path);
		if (engine.registry.adapterForPath(absolutePath) === undefined) return;

		const kind = readCallKind(event.input);
		if (kind === "ranged") return;

		return substituteLargeFullRead({
			engine,
			path,
			absolutePath,
			structureThresholdLines: readSettings.structureThresholdLines,
		});
	});
}

async function substituteLargeFullRead(options: {
	engine: ExploreEngine;
	path: string;
	absolutePath: string;
	structureThresholdLines: number;
}): Promise<ReadOverlayResult | undefined> {
	let lineCount: number;
	try {
		const source = await options.engine.sourceForFile(options.absolutePath);
		lineCount = source.ir.lineCount;
	} catch {
		// Unreadable / unsupported mid-flight — leave Pi result alone.
		return undefined;
	}

	if (!shouldOutlineFullRead(lineCount, options.structureThresholdLines)) return undefined;

	try {
		const result = await outlinePath(
			options.engine,
			options.path,
			DEFAULT_OUTLINE_OPTIONS,
			new AbortController().signal,
		);
		if (result.mode !== "file") return undefined;
		const outlineText =
			result.file.rows.length === 0 ? "No declarations" : formatOutlineFile(result.file, options.engine.cwd, false);
		return {
			content: [{ type: "text", text: formatLargeReadOutline(outlineText) }],
			details: {},
			isError: false,
		};
	} catch {
		return undefined;
	}
}

function readPathInput(input: Record<string, unknown>): string | undefined {
	const path = input.path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}
