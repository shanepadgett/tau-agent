import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	keyHint,
	truncateHead,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { Type } from "typebox";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import { formatPathForDisplay, resolveExplorePath, stripLeadingAt } from "./path-display.ts";
import type {
	AstClient,
	AstLanguage,
	OutlineEntry,
	OutlineFileResult,
	OutlineTarget,
	OutlineTargetResult,
	SymbolBatchResult,
} from "./ast-worker.ts";

const outlineParams = Type.Object(
	{
		path: Type.String({
			description: "TypeScript, TSX, Odin, Go, Rust, C#, Java, Kotlin, or Swift source file or directory",
		}),
		includePrivate: Type.Optional(Type.Boolean({ description: "Include private declarations and members" })),
		names: Type.Optional(
			Type.Array(Type.String(), {
				minItems: 1,
				description: "Exact top-level or member declaration names",
			}),
		),
	},
	{ additionalProperties: false },
);
const symbolParams = Type.Object(
	{
		locators: Type.Array(Type.Integer({ minimum: 1 }), {
			minItems: 1,
			description: "Numeric locators shown in parentheses by outline",
		}),
		contextLines: Type.Optional(
			Type.Integer({ minimum: 0, description: "Lines of source context before and after each declaration" }),
		),
	},
	{ additionalProperties: false },
);

interface AstToolDetails {
	kind: "outline" | "symbol";
	result: OutlineTargetResult | SymbolBatchResult;
	declarationCount: number;
	sourceBytes: number;
	returnedBytes: number;
	avoidedBytes: number;
	truncated: boolean;
}

interface LocatorRecord {
	id: number;
	token: string;
	path: string;
	name: string;
	stale: boolean;
}

type OutlineArgs = { path: string; includePrivate?: boolean; names?: string[] };

export function createAstTools(client: AstClient, rowState: ToolRowStateStore) {
	const locators = new Map<number, LocatorRecord>();
	let nextLocator = 1;

	function compact(
		text: string,
		sourceBytes: number,
		declarationCount: number,
		kind: AstToolDetails["kind"],
		result: OutlineTargetResult | SymbolBatchResult,
	): { text: string; details: AstToolDetails } {
		const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
		const returned = truncation.truncated
			? `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`
			: truncation.content;
		const returnedBytes = Buffer.byteLength(returned);
		return {
			text: returned,
			details: {
				kind,
				result,
				declarationCount,
				sourceBytes,
				returnedBytes,
				avoidedBytes: Math.max(0, sourceBytes - returnedBytes),
				truncated: truncation.truncated,
			},
		};
	}

	function locator(entry: OutlineEntry, path: string): number {
		const id = nextLocator++;
		const record = { id, token: entry.locator, path: resolve(path), name: entry.name, stale: false };
		locators.set(id, record);
		return id;
	}

	function renderEntry(entry: OutlineEntry, path: string, language: AstLanguage, indent: string): string {
		const lines =
			entry.range.start.line === entry.range.end.line
				? `${entry.range.start.line + 1}`
				: `${entry.range.start.line + 1}-${entry.range.end.line + 1}`;
		let signature = entry.signature.replace(/\s+/g, " ").trim();
		if (language === "odin") {
			signature = signature
				.replace(/\s*([(),:])\s*/g, "$1")
				.replace(/\s*->\s*/g, "->")
				.replace(/\s*:=\s*/g, ":=")
				.replace(/\s*\{\s*$/, "");
		}
		const label = signature && signature.includes(entry.name) ? signature : `${entry.name} ${signature}`.trim();
		return `${indent}${lines}(${locator(entry, path)}): ${label}`;
	}

	function renderOutlineFile(file: OutlineFileResult, cwd: string): string[] {
		const lines = [
			`${formatPathForDisplay(file.path, cwd)} (${file.language}, ${file.lineCount} lines, ${formatSize(file.byteLength)})`,
		];
		if (file.diagnostics.errorNodes > 0 || file.diagnostics.missingNodes > 0) {
			lines.push(
				`warning: parser recovered with ${file.diagnostics.errorNodes} ERROR and ${file.diagnostics.missingNodes} MISSING nodes`,
			);
		}
		const declarations = file.items.filter((item) => !item.isImport);
		const groups = new Map<string, typeof declarations>();
		for (const item of declarations) {
			const visibility = item.isExported ? "public" : "private";
			const key = `${visibility} ${item.symbolType}`;
			const group = groups.get(key);
			if (group) group.push(item);
			else groups.set(key, [item]);
		}
		for (const [label, items] of groups) {
			lines.push("", label);
			for (const item of items) {
				lines.push(renderEntry(item, file.path, file.language, ""));
				for (const member of item.members) {
					lines.push(renderEntry(member, file.path, file.language, "  "));
				}
			}
		}
		return lines;
	}

	const outline = defineTool<typeof outlineParams, AstToolDetails>({
		name: "outline",
		label: "outline",
		description:
			"Inspect public declarations in one supported source file or non-recursive package directory without returning implementation bodies. Parenthesized numbers are locators for symbol.",
		promptSnippet: "Inspect public declarations and get symbol locators without reading implementation bodies",
		promptGuidelines: [
			"Use a public package outline first to discover reusable APIs; add exact names when likely symbols are known.",
			"Set includePrivate when internal implementation discovery is needed.",
			"Treat each parenthesized number after a line range as that declaration's symbol locator.",
			"Use symbol with several locators when complete declaration source is needed.",
		],
		parameters: outlineParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const path = resolveExplorePath(ctx.cwd, params.path);
			const metadata = await stat(path);
			const target: OutlineTarget = metadata.isDirectory()
				? { kind: "directory", path }
				: { kind: "file", path, language: languageForPath(path) };
			const names = params.names ?? [];
			const result = await client.outline(target, params.includePrivate ?? false, names, signal);
			const lines = result.files.flatMap((file, index) => [
				...(index === 0 ? [] : [""]),
				...renderOutlineFile(file, ctx.cwd),
			]);
			const declarationCount = result.files.reduce(
				(count, file) =>
					count +
					file.items.reduce((fileCount, item) => fileCount + (item.isImport ? 0 : 1 + item.members.length), 0),
				0,
			);
			if (declarationCount === 0) lines.push(names.length > 0 ? "No matching declarations" : "No declarations");
			const output = compact(lines.join("\n"), result.totalByteLength, declarationCount, "outline", result);
			return { content: [{ type: "text", text: output.text }], details: output.details };
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const component =
				(context.lastComponent as AstCallComponent | undefined) ??
				new AstCallComponent(
					rowState,
					context.toolCallId,
					"outline",
					[stripLeadingAt(args.path)],
					outlineOptionVariants(args),
					theme,
				);
			component.set([stripLeadingAt(args.path)], outlineOptionVariants(args), theme);
			return component;
		},
		renderResult(result, options, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			return renderAstResult(result, options.expanded, theme, context);
		},
	});

	const symbol = defineTool<typeof symbolParams, AstToolDetails>({
		name: "symbol",
		label: "symbol",
		description:
			"Return exact declaration source for one or more numeric outline locators, with optional surrounding lines; stale locators fail atomically.",
		promptSnippet: "Retrieve exact declaration source for several outline locators",
		parameters: symbolParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const records = params.locators.map((id) => {
				const record = locators.get(id);
				if (!record) throw new Error(`Unknown symbol locator: ${id}. Run outline again.`);
				if (record.stale) throw new Error(`Symbol locator ${id} is stale. Run outline again.`);
				return record;
			});
			const result = await client.symbol(
				[...new Set(records.map((record) => record.token))],
				params.contextLines ?? 0,
				signal,
			);
			const requestedByToken = new Map(records.map((record) => [record.token, record]));
			const lines: string[] = [];
			for (const [blockIndex, block] of result.blocks.entries()) {
				if (blockIndex > 0) lines.push("");
				const represented = block.declarationIndexes.flatMap((index) => {
					const declaration = result.declarations[index];
					const record = declaration ? requestedByToken.get(declaration.locator) : undefined;
					return record ? [record] : [];
				});
				const range = block.returnedRange;
				const lineRange =
					range.start.line === range.end.line
						? `${range.start.line + 1}`
						: `${range.start.line + 1}-${range.end.line + 1}`;
				lines.push(
					formatPathForDisplay(block.path, ctx.cwd),
					`${lineRange}(${represented.map((record) => record.id).join(",")}): ${represented.map((record) => record.name).join(", ")}`,
					block.source,
				);
			}
			const sourceBytes = result.blocks.reduce((count, block) => count + Buffer.byteLength(block.source), 0);
			const output = compact(lines.join("\n"), sourceBytes, result.declarations.length, "symbol", result);
			return { content: [{ type: "text", text: output.text }], details: output.details };
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const targets = symbolTargetVariants(args.locators, locators);
			const component =
				(context.lastComponent as AstCallComponent | undefined) ??
				new AstCallComponent(
					rowState,
					context.toolCallId,
					"symbol",
					targets,
					[args.contextLines === undefined ? "" : `[context=${args.contextLines}]`],
					theme,
				);
			component.set(targets, [args.contextLines === undefined ? "" : `[context=${args.contextLines}]`], theme);
			return component;
		},
		renderResult(result, options, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			return renderAstResult(result, options.expanded, theme, context);
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

function renderAstResult(
	result: { content: Array<{ type: string; text?: string }>; details?: AstToolDetails },
	expanded: boolean,
	theme: Theme,
	context: { lastComponent?: Component; isError: boolean },
): Text {
	const details = result.details;
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	if (!expanded && !context.isError) {
		const declarationCount = details?.declarationCount ?? 0;
		const noun = declarationCount === 1 ? "declaration" : "declarations";
		const byteSummary = details
			? `, ${formatSize(details.returnedBytes)} returned, ${formatSize(details.avoidedBytes)} avoided`
			: "";
		text.setText(
			theme.fg("muted", `${declarationCount} ${noun}${byteSummary} (`) +
				keyHint("app.tools.expand", "to expand") +
				theme.fg("muted", ")"),
		);
		return text;
	}

	const output = result.content
		.filter((item): item is { type: string; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
	text.setText(
		output
			? output
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n")
			: "",
	);
	return text;
}

class AstCallComponent implements Component {
	private readonly rowState: ToolRowStateStore;
	private readonly rowId: string;
	private readonly tool: string;
	private targetVariants: string[];
	private optionVariants: string[];
	private theme: Theme;

	constructor(
		rowState: ToolRowStateStore,
		rowId: string,
		tool: string,
		targetVariants: string[],
		optionVariants: string[],
		theme: Theme,
	) {
		this.rowState = rowState;
		this.rowId = rowId;
		this.tool = tool;
		this.targetVariants = targetVariants;
		this.optionVariants = optionVariants;
		this.theme = theme;
	}

	set(targetVariants: string[], optionVariants: string[], theme: Theme): void {
		this.targetVariants = targetVariants;
		this.optionVariants = optionVariants;
		this.theme = theme;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const prefixWidth = visibleWidth(`${this.tool} → `);
		const shortestTarget = this.targetVariants.at(-1) ?? "";
		const minimumTargetWidth = Math.min(12, visibleWidth(shortestTarget));
		const options =
			this.optionVariants.find(
				(candidate) => prefixWidth + minimumTargetWidth + (candidate ? visibleWidth(candidate) + 1 : 0) <= width,
			) ??
			this.optionVariants.at(-1) ??
			"";
		const optionsWidth = options ? visibleWidth(options) + 1 : 0;
		const targetWidth = Math.max(1, width - prefixWidth - optionsWidth);
		const target = this.targetVariants.find((candidate) => visibleWidth(candidate) <= targetWidth) ?? shortestTarget;
		const displayTarget = truncateLeft(target, targetWidth);
		const line =
			formatToolRowTitle(this.rowState, this.rowId, this.tool, this.theme) +
			this.theme.fg("toolOutput", " → ") +
			this.theme.fg("accent", displayTarget) +
			(options ? ` ${this.theme.fg("muted", options)}` : "");
		return [truncateToWidth(line, width, "")];
	}

	invalidate(): void {}
}

function truncateLeft(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width === 1) return "…";

	let suffix = "";
	for (const character of Array.from(text).reverse()) {
		if (visibleWidth(`…${character}${suffix}`) > width) break;
		suffix = character + suffix;
	}
	return `…${suffix}`;
}

function outlineOptionVariants(args: OutlineArgs): string[] {
	const fixed = args.includePrivate ? ["private"] : [];
	const names = args.names ?? [];
	if (names.length === 0) return [fixed.length > 0 ? `[${fixed.join(" ")}]` : ""];

	const variants = [];
	for (let shown = names.length; shown >= 1; shown -= 1) {
		const omitted = names.length - shown;
		const namesText = omitted > 0 ? `${names.slice(0, shown).join(",")},+${omitted}` : names.join(",");
		variants.push(`[${[...fixed, `names=${namesText}`].join(" ")}]`);
	}
	variants.push(`[${[...fixed, `names=${names.length}`].join(" ")}]`);
	return variants;
}

function symbolTargetVariants(ids: readonly number[], locators: ReadonlyMap<number, LocatorRecord>): string[] {
	const records: LocatorRecord[] = [];
	for (const id of new Set(ids)) {
		const record = locators.get(id);
		if (!record) return [ids.join(",")];
		records.push(record);
	}
	const first = records[0];
	if (!first) return ["symbols"];

	const fileCount = new Set(records.map((record) => record.path)).size;
	const variants: string[] = [];
	if (fileCount === 1) {
		const file = basename(first.path);
		for (let shown = records.length; shown >= 1; shown -= 1) {
			const omitted = records.length - shown;
			const suffix = omitted > 0 ? `,+${omitted}` : "";
			variants.push(
				`${file}: ${records
					.slice(0, shown)
					.map((record) => record.name)
					.join(",")}${suffix}`,
			);
		}
		variants.push(`${file}: ${records.length} symbols`);
		return variants;
	}

	for (let shown = records.length; shown >= 1; shown -= 1) {
		const omitted = records.length - shown;
		const suffix = omitted > 0 ? `,+${omitted}` : "";
		variants.push(
			`${records
				.slice(0, shown)
				.map((record) => `${record.name}@${basename(record.path)}`)
				.join(",")}${suffix}`,
		);
	}
	variants.push(`${records.length} symbols in ${fileCount} files`);
	return variants;
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
