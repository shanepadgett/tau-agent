import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	keyHint,
	truncateHead,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
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
	SourceRange,
	OutlineTarget,
	OutlineTargetResult,
	SymbolBatchResult,
	SymbolView,
} from "./ast-worker.ts";

const outlineParams = Type.Object(
	{
		path: Type.String({
			description: "TypeScript, TSX, Odin, Go, Rust, C#, Java, Kotlin, Swift, or Markdown source file or directory",
		}),
		includePrivate: Type.Optional(Type.Boolean({ description: "Include private declarations and members" })),
		includeDocs: Type.Optional(
			Type.Boolean({ description: "Include attached documentation comments in declaration signatures" }),
		),
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
		view: StringEnum(["signature", "declaration", "declarationWithImports"] as const, {
			description:
				"Source view to retrieve; TypeScript, TSX, Odin, Go, Rust, C#, Java, Kotlin, Swift, and Markdown support selective views",
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
	declarationRetrieved: boolean;
	generation: number;
}

type OutlineArgs = { path: string; includePrivate?: boolean; includeDocs?: boolean; names?: string[] };

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
		if (!entry.locator) throw new Error(`Structural outline row ${entry.name} has no symbol locator`);
		const id = nextLocator++;
		const record = {
			id,
			token: entry.locator,
			path: resolve(path),
			name: entry.name,
			stale: false,
			declarationRetrieved: false,
			generation: client.getGeneration(),
		};
		locators.set(id, record);
		return id;
	}

	function renderEntry(
		entry: OutlineEntry,
		path: string,
		language: AstLanguage,
		indent: string,
		signatureOverride?: string,
	): string {
		const lines = displayLineRange(entry.range);
		let signature = (signatureOverride ?? entry.signature).trim();
		if (
			language === "typeScript" ||
			language === "tsx" ||
			language === "odin" ||
			language === "go" ||
			language === "rust" ||
			language === "cSharp" ||
			language === "java" ||
			language === "kotlin" ||
			language === "swift" ||
			language === "markdown"
		) {
			const signatureLines = signature.split("\n");
			const relativeNameLine = entry.nameRange.start.line - entry.range.start.line;
			const keywordNameLine =
				language === "go"
					? signatureLines.findIndex(
							(line) => /\b(?:func|type|const|var)\b/.test(line) && line.includes(entry.name),
						)
					: -1;
			let inBlockComment = false;
			let annotationDepth = 0;
			let attributeDepth = 0;
			const metadataLines = signatureLines.map((line) => {
				const trimmed = line.trimStart();
				if (inBlockComment) {
					if (trimmed.includes("*/")) inBlockComment = false;
					return true;
				}
				if (trimmed.startsWith("/*")) {
					inBlockComment = !trimmed.includes("*/");
					return true;
				}
				if (annotationDepth > 0) {
					annotationDepth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
					return true;
				}
				if (attributeDepth > 0) {
					attributeDepth += (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
					return true;
				}
				if (trimmed.startsWith("@") && !trimmed.startsWith(`@interface ${entry.name}`)) {
					annotationDepth = (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
					return true;
				}
				if (trimmed.startsWith("#[")) {
					attributeDepth = (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
					return true;
				}
				return trimmed.startsWith("//");
			});
			const declarationNameLine = signatureLines.findIndex(
				(line, index) => !metadataLines[index] && line.includes(entry.name),
			);
			const nameLine =
				relativeNameLine >= 0 && relativeNameLine === declarationNameLine
					? relativeNameLine
					: keywordNameLine >= 0
						? keywordNameLine
						: declarationNameLine;
			const declarationLine = language === "markdown" ? Math.max(0, relativeNameLine) : nameLine >= 0 ? nameLine : 0;
			const sourceLine = signatureLines[declarationLine] ?? entry.name;
			const first =
				language === "markdown" || sourceLine.includes(entry.name) ? sourceLine : `${entry.name} ${sourceLine}`;
			const warning =
				entry.certainty === "certain"
					? ""
					: ` [${entry.certainty}${entry.certaintyReason ? `: ${entry.certaintyReason}` : ""}]`;
			return [
				...signatureLines.slice(0, declarationLine).map((line) => `${indent}${line}`),
				`${indent}${lines}(${locator(entry, path)}): ${first}${warning}`,
				...signatureLines.slice(declarationLine + 1).map((line) => `${indent}${line}`),
			].join("\n");
		}
		signature = signature.replace(/\s+/g, " ");
		const label = signature && signature.includes(entry.name) ? signature : `${entry.name} ${signature}`.trim();
		return `${indent}${lines}(${locator(entry, path)}): ${label}`;
	}

	function renderStructuralEntry(entry: OutlineEntry, indent: string): string {
		const lines = displayLineRange(entry.range);
		return `${indent}${lines}: ${entry.signature.trim().replace(/\s+/g, " ")}`;
	}

	function containerFrame(
		item: OutlineFileResult["items"][number],
		language: AstLanguage,
	): { header: string; footer: string } | undefined {
		const firstMember = item.members[0];
		if (!firstMember) return undefined;
		if (
			(language === "odin" ||
				language === "cSharp" ||
				language === "java" ||
				language === "kotlin" ||
				language === "swift") &&
			item.bodyRange
		) {
			const bodyOffset = item.bodyRange.startByte - item.range.startByte;
			const signature = Buffer.from(item.signature);
			if (bodyOffset >= 0 && bodyOffset < signature.byteLength) {
				const header = signature
					.subarray(0, bodyOffset + 1)
					.toString("utf8")
					.trimEnd();
				if (header.endsWith("{")) return { header, footer: "}" };
			}
		}
		if (
			item.symbolType === "class" ||
			item.symbolType === "struct" ||
			item.symbolType === "interface" ||
			item.symbolType === "enum" ||
			item.symbolType === "object" ||
			item.symbolType === "namespace"
		) {
			const members = (
				language === "typeScript" ||
				language === "tsx" ||
				language === "cSharp" ||
				language === "java" ||
				language === "kotlin" ||
				language === "swift"
					? item.members.filter(
							(member) => member.qualifiedName.split(".").slice(0, -1).join(".") === item.qualifiedName,
						)
					: item.members
			)
				.map((member) =>
					(language === "java" &&
					(member.symbolType === "class" ||
						member.symbolType === "struct" ||
						member.symbolType === "interface" ||
						member.symbolType === "enum") &&
					member.signature.endsWith("{")
						? `${member.signature} … }`
						: member.signature
					)
						.split("\n")
						.map((line) => `  ${line}`)
						.join("\n"),
				)
				.join("\n");
			const braceSuffix = `\n${members}\n}`;
			if (item.signature.endsWith(braceSuffix))
				return { header: item.signature.slice(0, -braceSuffix.length), footer: "}" };
			const tupleMembers = item.members
				.map((member) =>
					`${member.signature},`
						.split("\n")
						.map((line) => `  ${line}`)
						.join("\n"),
				)
				.join("\n");
			const tupleSuffix = `\n${tupleMembers}\n);`;
			if (item.signature.endsWith(tupleSuffix))
				return { header: item.signature.slice(0, -tupleSuffix.length), footer: ");" };
			const tupleMarker = `\n${tupleMembers}\n)`;
			const tupleMarkerIndex = item.signature.lastIndexOf(tupleMarker);
			if (tupleMarkerIndex >= 0)
				return {
					header: item.signature.slice(0, tupleMarkerIndex),
					footer: item.signature.slice(tupleMarkerIndex + tupleMarker.length - 1),
				};
			if (item.symbolType === "class") return undefined;
		}

		const memberOffset = firstMember.range.startByte - item.range.startByte;
		const signature = Buffer.from(item.signature);
		if (memberOffset <= 0 || memberOffset > signature.byteLength) return undefined;
		const header = signature.subarray(0, memberOffset).toString("utf8").trimEnd();
		return header.endsWith("{") ? { header, footer: "}" } : undefined;
	}

	function renderOutlineFile(file: OutlineFileResult, cwd: string, includeHeader: boolean): string[] {
		const lines = includeHeader
			? [
					`${formatPathForDisplay(file.path, cwd)} (${file.language}, ${file.lineCount} lines, ${formatSize(file.byteLength)})`,
				]
			: [];
		if (file.diagnostics.errorNodes > 0 || file.diagnostics.missingNodes > 0) {
			lines.push(
				`warning: parser recovered with ${file.diagnostics.errorNodes} ERROR and ${file.diagnostics.missingNodes} MISSING nodes`,
			);
		}
		const declarations = file.items.filter((item) => item.rowKind === "declaration");
		if (
			file.language === "typeScript" ||
			file.language === "tsx" ||
			file.language === "odin" ||
			file.language === "go" ||
			file.language === "rust" ||
			file.language === "cSharp" ||
			file.language === "java" ||
			file.language === "kotlin" ||
			file.language === "swift" ||
			file.language === "markdown"
		) {
			let previousSection = "";
			for (const item of file.items) {
				const section =
					item.rowKind === "package"
						? "package"
						: item.rowKind === "import"
							? "imports"
							: item.rowKind === "export"
								? "exports"
								: item.rowKind === "sideEffect"
									? "side effects"
									: "declarations";
				if (section !== previousSection) {
					if (lines.length > 0) lines.push("");
					lines.push(section);
					previousSection = section;
				}
				const frame = item.rowKind === "declaration" ? containerFrame(item, file.language) : undefined;
				lines.push(
					item.rowKind !== "declaration"
						? renderStructuralEntry(item, "")
						: renderEntry(item, file.path, file.language, "", frame?.header),
				);
				const nestedContainers = new Map(
					file.language === "typeScript" ||
						file.language === "tsx" ||
						file.language === "odin" ||
						file.language === "cSharp" ||
						file.language === "java" ||
						file.language === "kotlin" ||
						file.language === "swift"
						? [item, ...item.members]
								.filter(
									(entry) =>
										entry.symbolType === "class" ||
										entry.symbolType === "struct" ||
										entry.symbolType === "interface" ||
										entry.symbolType === "enum",
								)
								.map((entry) => [entry.qualifiedName, entry] as const)
						: [],
				);
				const emittedEnumSeparators = new Set<string>();
				const openNestedDepths: number[] = [];
				for (const [memberIndex, member] of item.members.entries()) {
					const depth =
						file.language === "typeScript" ||
						file.language === "tsx" ||
						file.language === "odin" ||
						file.language === "cSharp" ||
						file.language === "java" ||
						file.language === "kotlin" ||
						file.language === "swift"
							? Math.max(1, member.qualifiedName.split(".").length - item.qualifiedName.split(".").length)
							: 1;
					const parent = member.qualifiedName.split(".").slice(0, -1).join(".");
					const siblings =
						file.language === "typeScript" ||
						file.language === "tsx" ||
						file.language === "odin" ||
						file.language === "cSharp" ||
						file.language === "java" ||
						file.language === "kotlin" ||
						file.language === "swift"
							? item.members.filter(
									(candidate) => candidate.qualifiedName.split(".").slice(0, -1).join(".") === parent,
								)
							: [];
					const parentIsEnum = file.language === "java" && nestedContainers.get(parent)?.symbolType === "enum";
					while (openNestedDepths.length > 0 && (openNestedDepths.at(-1) ?? 0) >= depth) {
						const closingDepth = openNestedDepths.pop();
						if (closingDepth !== undefined) lines.push(`${"  ".repeat(closingDepth)}}`);
					}
					if (
						parentIsEnum &&
						!siblings.some((candidate) => candidate.symbolType === "enumMember") &&
						!emittedEnumSeparators.has(parent)
					) {
						lines.push(`${"  ".repeat(depth)};`);
						emittedEnumSeparators.add(parent);
					}
					let memberSignature = member.signature;
					const nextMember = item.members[memberIndex + 1];
					const hasDescendants = nextMember?.qualifiedName.startsWith(`${member.qualifiedName}.`) ?? false;
					if (hasDescendants && memberSignature.endsWith(" { … }")) {
						memberSignature = `${memberSignature.slice(0, -" { … }".length)} {`;
						openNestedDepths.push(depth);
					}
					if (parentIsEnum && member.symbolType === "enumMember") {
						const constants = siblings.filter((candidate) => candidate.symbolType === "enumMember");
						const constantIndex = constants.indexOf(member);
						if (constantIndex + 1 < constants.length) memberSignature += ",";
						else if (siblings.some((candidate) => candidate.symbolType !== "enumMember")) memberSignature += ";";
					}
					lines.push(renderEntry(member, file.path, file.language, "  ".repeat(depth), memberSignature));
				}
				while (openNestedDepths.length > 0) {
					const closingDepth = openNestedDepths.pop();
					if (closingDepth !== undefined) lines.push(`${"  ".repeat(closingDepth)}}`);
				}
				if (frame) lines.push(frame.footer);
			}
			return lines;
		}
		const groups = new Map<string, typeof declarations>();
		for (const item of declarations) {
			const visibility = item.isExported ? "public" : "private";
			const key = `${visibility} ${item.symbolType}`;
			const group = groups.get(key);
			if (group) group.push(item);
			else groups.set(key, [item]);
		}
		for (const [label, items] of groups) {
			if (lines.length > 0) lines.push("");
			lines.push(label);
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
			"Leave includeDocs off for routine exploration; enable it when documentation comments are needed.",
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
			const result = await client.outline(
				target,
				params.includePrivate ?? false,
				params.includeDocs ?? false,
				names,
				signal,
			);
			const lines = result.files.flatMap((file, index) => [
				...(index === 0 ? [] : [""]),
				...renderOutlineFile(file, ctx.cwd, result.files.length > 1),
			]);
			const declarationCount = result.files.reduce(
				(count, file) =>
					count +
					file.items.reduce(
						(fileCount, item) => fileCount + (item.rowKind === "declaration" ? 1 + item.members.length : 0),
						0,
					),
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
			if (params.contextLines !== undefined && params.view !== "declaration") {
				throw new Error("contextLines is supported only with view=declaration");
			}
			const records = [...new Set(params.locators)].map((id) => {
				const record = locators.get(id);
				if (!record) throw new Error(`Unknown symbol locator: ${id}. Run outline again.`);
				if (record.stale) throw new Error(`Symbol locator ${id} is stale. Run outline again.`);
				if (record.generation !== client.getGeneration()) {
					throw new Error(`Symbol locator ${id} is stale because the AST worker restarted. Run outline again.`);
				}
				return record;
			});
			const result = await client.symbol(
				[...new Set(records.map((record) => record.token))],
				params.view,
				params.contextLines ?? 0,
				signal,
			);
			const requestedByToken = new Map<string, LocatorRecord[]>();
			for (const record of records) {
				const requested = requestedByToken.get(record.token);
				if (requested) requested.push(record);
				else requestedByToken.set(record.token, [record]);
			}
			const lines: string[] = [];
			const includePaths = new Set(result.blocks.map((block) => block.path)).size > 1;
			for (const [blockIndex, block] of result.blocks.entries()) {
				if (blockIndex > 0) lines.push("");
				const represented = block.declarationIndexes.flatMap((index) => {
					const declaration = result.declarations[index];
					return declaration ? (requestedByToken.get(declaration.locator) ?? []) : [];
				});
				const range = block.returnedRange;
				const lineRange = displayLineRange(range);
				lines.push(
					...(includePaths ? [formatPathForDisplay(block.path, ctx.cwd)] : []),
					`${lineRange}(${represented.map((record) => record.id).join(",")}): ${represented.map((record) => record.name).join(", ")}`,
					block.source,
				);
			}
			const sourceBytes = result.blocks.reduce((count, block) => count + Buffer.byteLength(block.source), 0);
			const output = compact(lines.join("\n"), sourceBytes, result.declarations.length, "symbol", result);
			if (output.details.truncated) {
				throw new Error("Symbol result exceeded the output limit. Request fewer locators.");
			}
			if (params.view === "declaration") for (const record of records) record.declarationRetrieved = true;
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
					[symbolOptions(args.view, args.contextLines)],
					theme,
				);
			component.set(targets, [symbolOptions(args.view, args.contextLines)], theme);
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

function displayLineRange(range: SourceRange): string {
	const endLine =
		range.endByte > range.startByte && range.end.column === 0
			? Math.max(range.start.line, range.end.line - 1)
			: range.end.line;
	return range.start.line === endLine ? `${range.start.line + 1}` : `${range.start.line + 1}-${endLine + 1}`;
}

function symbolOptions(view: SymbolView, contextLines: number | undefined): string {
	return `[${view}${contextLines === undefined ? "" : ` context=${contextLines}`}]`;
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
	const fixed = [...(args.includePrivate ? ["private"] : []), ...(args.includeDocs ? ["docs"] : [])];
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
		case ".md":
		case ".markdown":
		case ".mdown":
			return "markdown";
		default:
			throw new Error(`Unsupported outline file type: ${extname(path) || "no extension"}`);
	}
}
