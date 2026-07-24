import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { extname, resolve } from "node:path";
import { Type } from "typebox";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import { formatPathForDisplay, resolveExplorePath, stripLeadingAt } from "./path-display.ts";
import type { AstClient, AstLanguage, OutlineEntry, OutlineResult, SymbolResult } from "./ast-worker.ts";

const outlineParams = Type.Object(
	{
		path: Type.String({
			description: "TypeScript, TSX, Odin, Go, Rust, C#, Java, Kotlin, or Swift source file",
		}),
	},
	{ additionalProperties: false },
);
const symbolParams = Type.Object(
	{ locator: Type.String({ description: "Opaque locator returned by outline" }) },
	{ additionalProperties: false },
);

interface AstToolDetails {
	kind: "outline" | "symbol";
	result: OutlineResult | SymbolResult;
	sourceBytes: number;
	returnedBytes: number;
	avoidedBytes: number;
	truncated: boolean;
}

interface LocatorRecord {
	token: string;
	path: string;
	stale: boolean;
}

export function createAstTools(client: AstClient, rowState: ToolRowStateStore) {
	const locators = new Map<string, LocatorRecord>();
	let nextLocator = 1;

	function compact(
		text: string,
		sourceBytes: number,
		result: OutlineResult | SymbolResult,
	): {
		text: string;
		details: AstToolDetails;
	} {
		const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
		const returned = truncation.truncated
			? `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`
			: truncation.content;
		const returnedBytes = Buffer.byteLength(returned);
		return {
			text: returned,
			details: {
				kind: "items" in result ? "outline" : "symbol",
				result,
				sourceBytes,
				returnedBytes,
				avoidedBytes: Math.max(0, sourceBytes - returnedBytes),
				truncated: truncation.truncated,
			},
		};
	}

	function locator(entry: OutlineEntry, path: string): string {
		const id = `ast:${nextLocator++}`;
		locators.set(id, { token: entry.locator, path: resolve(path), stale: false });
		return id;
	}

	function renderEntry(entry: OutlineEntry, path: string, indent: string): string {
		const lines =
			entry.range.start.line === entry.range.end.line
				? `L${entry.range.start.line + 1}`
				: `L${entry.range.start.line + 1}-${entry.range.end.line + 1}`;
		const signature = entry.signature.replace(/\s+/g, " ").trim();
		const label = signature && signature.includes(entry.name) ? signature : `${entry.name} ${signature}`.trim();
		return `${indent}${locator(entry, path)} ${lines} ${entry.symbolType} ${label}`;
	}

	const outline = defineTool<typeof outlineParams, AstToolDetails>({
		name: "outline",
		label: "outline",
		description:
			"Inspect declarations in one TypeScript, TSX, Odin, Go, Rust, C#, Java, Kotlin, or Swift file without returning implementation bodies.",
		promptSnippet: "Inspect declarations and get symbol locators without reading implementation bodies",
		promptGuidelines: [
			"Use outline before whole-file read when discovering the structure of a TypeScript, TSX, Odin, Go, Rust, C#, Java, Kotlin, or Swift source file.",
			"Use symbol with a locator returned by outline when implementation source is needed.",
		],
		parameters: outlineParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const path = resolveExplorePath(ctx.cwd, params.path);
			const language = languageForPath(path);
			const result = await client.outline(path, language, signal);
			const lines = [
				`${formatPathForDisplay(result.path, ctx.cwd)} (${result.language}, ${result.lineCount} lines, ${formatSize(result.byteLength)})`,
			];
			if (result.diagnostics.errorNodes > 0 || result.diagnostics.missingNodes > 0) {
				lines.push(
					`warning: parser recovered with ${result.diagnostics.errorNodes} ERROR and ${result.diagnostics.missingNodes} MISSING nodes`,
				);
			}
			for (const item of result.items) {
				lines.push(renderEntry(item, result.path, ""));
				for (const member of item.members) lines.push(renderEntry(member, result.path, "  "));
			}
			if (result.items.length === 0) lines.push("No declarations");
			const output = compact(lines.join("\n"), result.byteLength, result);
			return { content: [{ type: "text", text: output.text }], details: output.details };
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const title = formatToolRowTitle(rowState, context.toolCallId, "outline", theme);
			text.setText(`${title} ${theme.fg("muted", stripLeadingAt(args.path))}`);
			return text;
		},
		renderResult(result, options, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const content = result.content.find((item) => item.type === "text");
			text.setText(options.expanded && content?.type === "text" ? content.text : "");
			return text;
		},
	});

	const symbol = defineTool<typeof symbolParams, AstToolDetails>({
		name: "symbol",
		label: "symbol",
		description: "Return the exact declaration source for one opaque locator from outline; stale locators fail.",
		promptSnippet: "Retrieve exact declaration source from an outline locator",
		parameters: symbolParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const record = locators.get(params.locator);
			if (!record) throw new Error(`Unknown AST locator: ${params.locator}. Run outline again.`);
			if (record.stale) throw new Error(`AST locator ${params.locator} is stale. Run outline again.`);
			const result = await client.symbol(record.token, signal);
			const header = `${formatPathForDisplay(result.path, ctx.cwd)}:${result.range.start.line + 1}-${result.range.end.line + 1}`;
			const output = compact(`${header}\n${result.source}`, Buffer.byteLength(result.source), result);
			return { content: [{ type: "text", text: output.text }], details: output.details };
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const title = formatToolRowTitle(rowState, context.toolCallId, "symbol", theme);
			text.setText(`${title} ${theme.fg("muted", args.locator)}`);
			return text;
		},
		renderResult(result, options, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const content = result.content.find((item) => item.type === "text");
			text.setText(options.expanded && content?.type === "text" ? content.text : "");
			return text;
		},
	});

	return {
		outline,
		symbol,
		clear() {
			locators.clear();
			nextLocator = 1;
		},
		invalidate(paths: readonly string[]) {
			const changed = new Set(paths.map((path) => resolve(path)));
			for (const record of locators.values()) {
				if (changed.has(record.path)) record.stale = true;
			}
		},
	};
}

function languageForPath(path: string): AstLanguage {
	switch (extname(path).toLowerCase()) {
		case ".ts":
			return "typeScript";
		case ".tsx":
			return "tsx";
		case ".odin":
			return "odin";
		case ".go":
			return "go";
		case ".rs":
			return "rust";
		case ".cs":
			return "cSharp";
		case ".java":
			return "java";
		case ".kt":
		case ".ktm":
		case ".kts":
			return "kotlin";
		case ".swift":
			return "swift";
		default:
			throw new Error(`Unsupported outline file type: ${extname(path) || "no extension"}`);
	}
}
