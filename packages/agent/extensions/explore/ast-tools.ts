import { defineTool, formatSize, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Type } from "typebox";
import {
	BoundedTextResultBuilder,
	truncateBoundedHead,
	type BoundedTextOverflowDetails,
} from "../../shared/bounded-text-result.ts";
import type { TemporaryOutputStore } from "../../shared/temporary-output-store.ts";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import {
	AST_LANGUAGE_REGISTRY,
	astLanguageForPath,
	formatAstLanguageLabels,
	requireAstLanguageForPath,
	type AstLanguage,
} from "./ast-languages.ts";
import type { OrientationState } from "./orientation-state.ts";
import { formatPathForDisplay, resolveExplorePath, stripLeadingAt } from "./path-display.ts";
import {
	AstWorkerError,
	type ApiCandidate,
	type ApiDeclarationKind,
	type ApiDiscoveryResult,
	type ApiQuery,
	type ApiSurfaceFilter,
	type AstSearchResult,
	type AstClient,
	type OutlineEntry,
	type OutlineFileResult,
	type SourceRange,
	type OutlineTarget,
	type OutlineTargetResult,
	type RecursiveOutlineSummary,
	type RelationshipOperation,
	type RelationshipResult,
	type SymbolBatchResult,
	type SymbolView,
} from "./ast-worker.ts";

const supportedLanguageLabels = formatAstLanguageLabels(AST_LANGUAGE_REGISTRY, "or");

const outlineParams = Type.Object(
	{
		path: Type.String({
			description: `${supportedLanguageLabels} source file or directory`,
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
		recursive: Type.Optional(
			Type.Boolean({ description: "Recursively outline every supported source file below a directory" }),
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
		view: StringEnum(["signature", "signatureWithDocs", "declaration", "declarationWithImports"] as const, {
			description: `Source view to retrieve: signature omits docs and bodies; signatureWithDocs adds attached docs; declaration returns exact source; declarationWithImports adds required imports. ${supportedLanguageLabels} support selective views`,
		}),
		contextLines: Type.Optional(
			Type.Integer({ minimum: 0, description: "Lines of source context before and after each declaration" }),
		),
	},
	{ additionalProperties: false },
);
const apiDeclarationKinds = [
	"module",
	"namespace",
	"package",
	"class",
	"method",
	"property",
	"field",
	"constructor",
	"enum",
	"interface",
	"function",
	"variable",
	"constant",
	"object",
	"enumMember",
	"struct",
	"event",
	"operator",
	"typeParameter",
	"heading",
] as const satisfies readonly ApiDeclarationKind[];
const apiDiscoverParams = Type.Object(
	{
		path: Type.String({ description: "Repository, package, or subtree directory" }),
		query: Type.Union([
			Type.Object(
				{ kind: Type.Literal("exactName"), name: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
			Type.Object(
				{ kind: Type.Literal("prefixName"), name: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
			Type.Object(
				{ kind: Type.Literal("substringName"), name: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
			Type.Object(
				{
					kind: Type.Literal("fuzzyName"),
					name: Type.String({ minLength: 1 }),
					maxCandidates: Type.Integer({ minimum: 1, maximum: 10_000 }),
					maxWork: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					kind: Type.Literal("declarationKind"),
					declarationKind: StringEnum(apiDeclarationKinds),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					kind: Type.Literal("documentation"),
					terms: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
					maxCandidates: Type.Integer({ minimum: 1, maximum: 10_000 }),
					maxWork: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
				},
				{ additionalProperties: false },
			),
		]),
		surface: StringEnum(["all", "public", "private", "sourceExport", "packageSurface"] as const, {
			description: "Declaration or export surface to search",
		}),
		resultLimit: Type.Integer({ minimum: 1, maximum: 100 }),
	},
	{ additionalProperties: false },
);
const astSearchParams = Type.Object(
	{
		path: Type.String({ description: "Supported source file, repository, package, or subtree" }),
		pattern: Type.String({ minLength: 1, maxLength: 16 * 1024, description: "ast-grep code pattern" }),
		language: Type.Optional(
			StringEnum(
				["typeScript", "tsx", "odin", "go", "rust", "cSharp", "java", "kotlin", "swift", "markdown"] as const,
				{ description: "Explicit pattern and target language; required for directory targets" },
			),
		),
		resultLimit: Type.Integer({ minimum: 1, maximum: 100 }),
	},
	{ additionalProperties: false },
);
const relationshipParams = Type.Object(
	{
		path: Type.String({ description: "Repository, package, or subtree directory" }),
		locator: Type.Integer({ minimum: 1, description: "Numeric declaration locator" }),
		resultLimit: Type.Integer({ minimum: 1, maximum: 100 }),
	},
	{ additionalProperties: false },
);

interface AstToolDetails {
	kind: "outline" | "symbol" | "apiDiscover" | "astSearch" | "relationship";
	result:
		| OutlineTargetResult
		| SymbolBatchResult
		| ApiDiscoveryResult
		| AstSearchResult
		| RelationshipResult
		| { path: string; summary: RecursiveOutlineSummary; visibleFiles: string[] };
	declarationCount: number;
	sourceBytes: number;
	returnedBytes: number;
	avoidedBytes: number;
	truncated: boolean;
	overflow: BoundedTextOverflowDetails | undefined;
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

type OutlineArgs = {
	path: string;
	includePrivate?: boolean;
	includeDocs?: boolean;
	names?: string[];
	recursive?: boolean;
};

export function createAstTools(
	client: AstClient,
	rowState: ToolRowStateStore,
	temporaryOutput: TemporaryOutputStore,
	orientation: OrientationState,
) {
	const locators = new Map<number, LocatorRecord>();
	let nextLocator = 1;

	function compact(
		text: string,
		sourceBytes: number,
		declarationCount: number,
		kind: AstToolDetails["kind"],
		result: OutlineTargetResult | SymbolBatchResult,
	): { text: string; visibleText: string; details: AstToolDetails } {
		const truncation = truncateBoundedHead(text);
		const returned = truncation.truncated
			? `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`
			: truncation.content;
		const returnedBytes = Buffer.byteLength(returned);
		return {
			text: returned,
			visibleText: truncation.content,
			details: {
				kind,
				result,
				declarationCount,
				sourceBytes,
				returnedBytes,
				avoidedBytes: Math.max(0, sourceBytes - returnedBytes),
				truncated: truncation.truncated,
				overflow: undefined,
			},
		};
	}

	function locator(entry: OutlineEntry, path: string): number {
		if (!entry.locator) throw new Error(`Structural outline row ${entry.name} has no symbol locator`);
		return registerLocator(entry.locator, path, entry.name);
	}

	function registerLocator(token: string, path: string, name: string): number {
		const id = nextLocator++;
		const record = {
			id,
			token,
			path: resolve(path),
			name,
			stale: false,
			declarationRetrieved: false,
			generation: client.getGeneration(),
		};
		locators.set(id, record);
		return id;
	}

	function renderApiCandidate(candidate: ApiCandidate, id: number, cwd: string): string {
		const lines = [
			`${formatPathForDisplay(candidate.definingFile, cwd)}:${displayLineRange(candidate.range)}(${id}): ${candidate.name} — ${candidate.symbolType}`,
			...candidate.signature
				.trim()
				.split("\n")
				.map((line) => `  ${line}`),
			`  surface: visibility=${candidate.visibility}, sourceExport=${candidate.sourceExport}, packageSurface=${candidate.packageSurface}, internalOnly=${candidate.internalOnly}`,
		];
		if (candidate.callerAccess) {
			lines.push(
				`  caller: ${candidate.callerAccess.importStatement} use ${candidate.callerAccess.accessExpression}`,
			);
		}
		if (candidate.reExportChain.length > 1) lines.push(`  re-exports: ${candidate.reExportChain.join(" -> ")}`);
		const resolution = [`provenance=${candidate.provenance}`, `parse=${candidate.certainty}`];
		if (candidate.certaintyReason) resolution.push(candidate.certaintyReason);
		lines.push(`  resolution: ${resolution.join(", ")}`);
		if (candidate.uncertainty) lines.push(`  uncertainty: ${candidate.uncertainty}`);
		return lines.join("\n");
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
			"Inspect declarations in one supported source file, one non-recursive package directory, or a recursive mixed-language subtree without returning implementation bodies. Parenthesized numbers are locators for symbol.",
		promptSnippet: "Inspect public declarations and get symbol locators without reading implementation bodies",
		promptGuidelines: [
			"Set recursive=true to orient an unfamiliar repository or subtree across supported languages.",
			"Set includePrivate when internal implementation discovery is needed.",
			"Leave includeDocs off for routine exploration; enable it when documentation comments are needed.",
			"Treat each parenthesized number after a line range as that declaration's symbol locator.",
			"Use symbol(signatureWithDocs) when one documented contract is needed without its implementation body.",
			"Use symbol with several locators when complete declaration source is needed.",
		],
		parameters: outlineParams,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const path = await realpath(resolveExplorePath(ctx.cwd, params.path));
			const metadata = await stat(path);
			if (params.recursive) {
				if (!metadata.isDirectory()) throw new Error("recursive outline requires a directory target");
				const names = params.names ?? [];
				const builder = new BoundedTextResultBuilder(temporaryOutput, "completeBlocks");
				const filesByPath = new Map<
					string,
					{ file: OutlineFileResult; locatorIds: number[]; renderedBytes: number }
				>();
				const allLocatorIds = new Set<number>();
				const fatalFallbacks: Array<{
					path: string;
					fingerprint: string;
					message: string;
					code: "outlineFailed" | "resultFrameTooLarge";
				}> = [];
				let declarationCount = 0;
				try {
					const summary = await client.outlineRecursive(
						path,
						params.includePrivate ?? false,
						params.includeDocs ?? false,
						names,
						{
							async onFile(_relativePath, file) {
								const firstLocator = nextLocator;
								const block = renderOutlineFile(file, ctx.cwd, true).join("\n");
								const fileLocatorIds = Array.from(
									{ length: nextLocator - firstLocator },
									(_, index) => firstLocator + index,
								);
								filesByPath.set(file.path, {
									file,
									locatorIds: fileLocatorIds,
									renderedBytes: Buffer.byteLength(block),
								});
								for (const id of fileLocatorIds) allLocatorIds.add(id);
								declarationCount += file.items.reduce(
									(count, item) => count + (item.rowKind === "declaration" ? 1 + item.members.length : 0),
									0,
								);
								await builder.appendBlock(file.path, formatPathForDisplay(file.path, ctx.cwd), block);
							},
							async onDiagnostic(diagnostic) {
								if (
									(diagnostic.code === "outlineFailed" || diagnostic.code === "resultFrameTooLarge") &&
									diagnostic.sourceFingerprint
								) {
									fatalFallbacks.push({
										path: resolve(path, diagnostic.relativePath),
										fingerprint: diagnostic.sourceFingerprint,
										message: diagnostic.message,
										code: diagnostic.code,
									});
								}
								const language = diagnostic.language ? ` (${diagnostic.language})` : "";
								await builder.appendBlock(
									undefined,
									diagnostic.relativePath,
									`diagnostic: ${diagnostic.relativePath}${language} [${diagnostic.code}]: ${diagnostic.message}`,
								);
							},
						},
						signal,
					);
					const limits = [
						...(summary.fileLimitReached ? ["file count"] : []),
						...(summary.sourceByteLimitReached ? ["source bytes"] : []),
						...(summary.depthLimitReached ? ["depth"] : []),
						...(summary.elapsedLimitReached ? ["elapsed time"] : []),
					];
					await builder.appendRequiredBlock(
						"recursive outline summary",
						[
							`summary: ${summary.emittedFiles} outlined, ${summary.supportedFiles} supported, ${summary.unsupportedFiles} unsupported, ${summary.failedFiles} failed, ${summary.unreadableFiles} unreadable, ${summary.oversizedFiles} oversized`,
							`source: ${summary.totalLineCount} lines, ${formatSize(summary.totalByteLength)}; parser degraded: ${summary.parserDegradedFiles}; limits reached: ${limits.join(", ") || "none"}`,
						].join("\n"),
					);
					const bounded = await builder.finish();
					if (!bounded.overflow.fullOutputComplete) {
						const visible = new Set(bounded.visibleUnitIds);
						for (const [file, { locatorIds: ids }] of filesByPath) {
							if (visible.has(file)) continue;
							for (const id of ids) locators.delete(id);
						}
					}
					const returnedBytes = Buffer.byteLength(bounded.content);
					for (const filePath of bounded.visibleUnitIds) {
						const record = filesByPath.get(filePath);
						if (!record) continue;
						orientation.recordVisible({
							path: record.file.path,
							toolCallId,
							fingerprint: record.file.sourceFingerprint,
							includePrivate: params.includePrivate ?? false,
							names,
							diagnostics: record.file.diagnostics,
							locatorIds: record.locatorIds,
							sourceBytesDeflected: Math.max(0, record.file.byteLength - record.renderedBytes),
						});
					}
					for (const fallback of fatalFallbacks) {
						orientation.recordFatal({
							...fallback,
							includePrivate: params.includePrivate ?? false,
							names,
						});
					}
					if (bounded.overflow.temporaryPath) {
						orientation.recordTemporaryOutput(bounded.overflow.temporaryPath);
					}
					orientation.recordOutlineTelemetry(toolCallId, {
						workerInputBytes: summary.totalByteLength,
						completeRenderedBytes: bounded.overflow.totalBytes,
						modelVisibleAstBytes: returnedBytes,
						temporaryOutputBytes: bounded.overflow.temporaryPath ? bounded.overflow.totalBytes : 0,
					});
					return {
						content: [{ type: "text", text: bounded.content }],
						details: {
							kind: "outline",
							result: { path, summary, visibleFiles: bounded.visibleUnitIds },
							declarationCount,
							sourceBytes: summary.totalByteLength,
							returnedBytes,
							avoidedBytes: Math.max(0, summary.totalByteLength - returnedBytes),
							truncated: bounded.overflow.truncated,
							overflow: bounded.overflow,
						},
					};
				} catch (error) {
					await builder.abort();
					for (const id of allLocatorIds) locators.delete(id);
					throw error;
				}
			}
			const target: OutlineTarget = metadata.isDirectory()
				? { kind: "directory", path }
				: { kind: "file", path, language: requireAstLanguageForPath(path) };
			const names = params.names ?? [];
			let result: OutlineTargetResult;
			try {
				result = await client.outline(
					target,
					params.includePrivate ?? false,
					params.includeDocs ?? false,
					names,
					signal,
				);
			} catch (error) {
				if (
					target.kind === "file" &&
					error instanceof AstWorkerError &&
					(error.code === "outline_failed" || error.code === "response_too_large") &&
					error.sourceFingerprint
				) {
					orientation.recordFatal({
						path,
						fingerprint: error.sourceFingerprint,
						includePrivate: params.includePrivate ?? false,
						names,
						code: error.code,
						message: error.message,
					});
				}
				throw error;
			}
			const renderedFiles = result.files.map((file) => {
				const firstLocator = nextLocator;
				const text = renderOutlineFile(file, ctx.cwd, result.files.length > 1).join("\n");
				return {
					file,
					text,
					locatorIds: Array.from({ length: nextLocator - firstLocator }, (_, index) => firstLocator + index),
				};
			});
			const lines = renderedFiles.flatMap((file, index) => [...(index === 0 ? [] : [""]), file.text]);
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
			const completeText = lines.join("\n");
			const output = compact(completeText, result.totalByteLength, declarationCount, "outline", result);
			let offset = 0;
			for (const [index, rendered] of renderedFiles.entries()) {
				const start = offset;
				const end = start + rendered.text.length;
				const visible =
					!output.details.truncated ||
					(output.visibleText.length >= end && output.visibleText.slice(start, end) === rendered.text);
				if (visible) {
					const renderedBytes = Buffer.byteLength(rendered.text);
					orientation.recordVisible({
						path: rendered.file.path,
						toolCallId,
						fingerprint: rendered.file.sourceFingerprint,
						includePrivate: params.includePrivate ?? false,
						names,
						diagnostics: rendered.file.diagnostics,
						locatorIds: rendered.locatorIds,
						sourceBytesDeflected: Math.max(0, rendered.file.byteLength - renderedBytes),
					});
				}
				offset = end + (index + 1 < renderedFiles.length ? 2 : 0);
			}
			orientation.recordOutlineTelemetry(toolCallId, {
				workerInputBytes: result.totalByteLength,
				completeRenderedBytes: Buffer.byteLength(completeText),
				modelVisibleAstBytes: output.details.returnedBytes,
				temporaryOutputBytes: 0,
			});
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
			"Return signatures, documented signatures, exact declarations, or declarations with required imports for numeric outline locators; stale locators fail atomically.",
		promptSnippet: "Retrieve signatures or exact declarations for several outline locators",
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
					...block.declarationIndexes.flatMap((index) => {
						const declaration = result.declarations[index];
						if (!declaration) return [];
						const ids = (requestedByToken.get(declaration.locator) ?? []).map((record) => record.id).join(",");
						return declaration.diagnostics.map((diagnostic) => `warning (${ids}): ${diagnostic}`);
					}),
					block.source,
				);
			}
			const sourceBytes = result.blocks.reduce((count, block) => count + Buffer.byteLength(block.source), 0);
			const output = compact(lines.join("\n"), sourceBytes, result.declarations.length, "symbol", result);
			if (output.details.truncated) {
				throw new Error("Symbol result exceeded the output limit. Request fewer locators.");
			}
			if (params.view === "declaration") for (const record of records) record.declarationRetrieved = true;
			orientation.recordSymbols(
				records.map((record) => ({ path: record.path, locatorId: record.id, view: params.view })),
			);
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

	const apiDiscover = defineTool<typeof apiDiscoverParams, AstToolDetails>({
		name: "api_discover",
		label: "api_discover",
		description:
			"Discover declarations and supported caller import paths across a canonical repository, package, or subtree without returning implementation bodies. Results include numeric symbol locators.",
		promptSnippet: "Find reusable declarations and caller import paths across a repository or subtree",
		promptGuidelines: [
			"Use api_discover when reuse intent is known but the declaration path or exact name is not.",
			"Choose exactly one query kind and keep fuzzy or documentation work limits narrow.",
			"Use packageSurface when the caller needs a supported public import path.",
			"Pass a returned numeric locator to symbol(signatureWithDocs) before reading implementation source.",
		],
		parameters: apiDiscoverParams,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const path = await realpath(resolveExplorePath(ctx.cwd, params.path));
			if (!(await stat(path)).isDirectory()) throw new Error("api_discover requires a directory scope");
			const result = await client.discoverApi(
				path,
				params.query as ApiQuery,
				params.surface as ApiSurfaceFilter,
				params.resultLimit,
				signal,
			);
			const builder = new BoundedTextResultBuilder(temporaryOutput, "completeBlocks");
			const locatorByUnit = new Map<string, number>();
			try {
				for (const [index, candidate] of result.candidates.entries()) {
					const id = registerLocator(candidate.locator, candidate.definingFile, candidate.name);
					const unit = `${candidate.definingFile}:${candidate.range.startByte}:${index}`;
					locatorByUnit.set(unit, id);
					await builder.appendBlock(unit, candidate.name, renderApiCandidate(candidate, id, ctx.cwd));
				}
				if (result.candidates.length === 0)
					await builder.appendRequiredBlock("no matches", "No matching declarations");
				const summary = result.summary;
				const limits = [
					...(summary.candidateLimitReached ? ["query candidates"] : []),
					...(summary.workLimitReached ? ["query work"] : []),
					...(summary.fileLimitReached ? ["files"] : []),
					...(summary.sourceByteLimitReached ? ["source bytes"] : []),
					...(summary.depthLimitReached ? ["depth"] : []),
					...(summary.elapsedLimitReached ? ["elapsed time"] : []),
				];
				await builder.appendRequiredBlock(
					"API discovery summary",
					[
						`summary: ${summary.filesScanned} files scanned, ${summary.declarationsConsidered} declarations considered, ${summary.resultsReturned} results returned, ${summary.omittedCandidates} candidates omitted`,
						`result limit: ${summary.resultLimit}; source: ${formatSize(summary.totalSourceBytes)}; resolution diagnostics: ${summary.resolutionDiagnostics}; limits reached: ${limits.join(", ") || "none"}`,
					].join("\n"),
				);
				const bounded = await builder.finish();
				if (!bounded.overflow.fullOutputComplete) {
					const visible = new Set(bounded.visibleUnitIds);
					for (const [unit, id] of locatorByUnit) if (!visible.has(unit)) locators.delete(id);
				}
				if (bounded.overflow.temporaryPath) orientation.recordTemporaryOutput(bounded.overflow.temporaryPath);
				const returnedBytes = Buffer.byteLength(bounded.content);
				return {
					content: [{ type: "text", text: bounded.content }],
					details: {
						kind: "apiDiscover",
						result,
						declarationCount: result.candidates.length,
						sourceBytes: summary.totalSourceBytes,
						returnedBytes,
						avoidedBytes: Math.max(0, summary.totalSourceBytes - returnedBytes),
						truncated: bounded.overflow.truncated,
						overflow: bounded.overflow,
					},
				};
			} catch (error) {
				await builder.abort();
				for (const id of locatorByUnit.values()) locators.delete(id);
				throw error;
			}
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const query = formatApiQuery(args.query as ApiQuery);
			const component =
				(context.lastComponent as AstCallComponent | undefined) ??
				new AstCallComponent(
					rowState,
					context.toolCallId,
					"api_discover",
					[stripLeadingAt(args.path)],
					[`[${query} ${args.surface} limit=${args.resultLimit}]`],
					theme,
				);
			component.set([stripLeadingAt(args.path)], [`[${query} ${args.surface} limit=${args.resultLimit}]`], theme);
			return component;
		},
		renderResult(result, options, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			return renderAstResult(result, options.expanded, theme, context);
		},
	});

	const astSearch = defineTool<typeof astSearchParams, AstToolDetails>({
		name: "ast_search",
		label: "ast_search",
		description:
			"Search one canonical source file, repository, package, or subtree with an ast-grep code pattern. Returns bounded deterministic matches, metavariable bindings, parser certainty, and numeric locators for exact source or enclosing scopes.",
		promptSnippet: "Search repository code shapes with ast-grep patterns and retrievable locators",
		promptGuidelines: [
			"Use ast_search for code shapes; use grep for literal text.",
			"Pass language for repository, package, and subtree targets. Supported files can infer it.",
			"Use $NAME and $$$NAME metavariables. Keep resultLimit narrow, then retrieve selected numeric locators with symbol(declaration).",
		],
		parameters: astSearchParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const path = await realpath(resolveExplorePath(ctx.cwd, params.path));
			const metadata = await stat(path);
			const inferred = metadata.isFile() ? astLanguageForPath(path) : undefined;
			if (metadata.isFile() && !inferred) throw new Error(`Unsupported ast_search file type: ${path}`);
			if (metadata.isDirectory() && !params.language) {
				throw new Error("ast_search requires language for repository, package, and subtree targets");
			}
			if (inferred && params.language && inferred !== params.language) {
				throw new Error(`ast_search language ${params.language} does not match ${inferred} target ${path}`);
			}
			const language = params.language ?? inferred;
			if (!language) throw new Error("ast_search could not infer a language; pass language explicitly");
			const result = await client.search(path, language, params.pattern, params.resultLimit, signal);
			const builder = new BoundedTextResultBuilder(temporaryOutput, "completeBlocks");
			const locatorByUnit = new Map<string, number[]>();
			try {
				for (const [index, match] of result.matches.entries()) {
					const sourcePath = metadata.isDirectory() ? resolve(path, match.relativePath) : path;
					const matchId = registerLocator(match.locator, sourcePath, `match ${match.relativePath}`);
					const ids = [matchId];
					const unit = `${match.relativePath}:${match.range.startByte}:${index}`;
					const lines = [
						`${match.relativePath}:${displayLineRange(match.range)}(${matchId}) [${match.language}, ${match.certainty}]`,
						...match.preview.split("\n").map((line) => `  ${line}`),
					];
					if (match.previewTruncated) lines.push("  [preview truncated]");
					for (const binding of match.bindings) {
						const values = binding.values.map((value) => JSON.stringify(value.preview)).join(", ");
						lines.push(`  $${binding.name} = ${values}${binding.valuesTruncated ? ", …" : ""}`);
					}
					if (match.bindingsTruncated) lines.push("  [bindings truncated]");
					if (match.certaintyReason) lines.push(`  uncertainty: ${match.certaintyReason}`);
					if (match.enclosingScope) {
						const scopeId = registerLocator(
							match.enclosingScope.locator,
							sourcePath,
							match.enclosingScope.astKind,
						);
						ids.push(scopeId);
						lines.push(
							`  enclosing ${displayLineRange(match.enclosingScope.range)}(${scopeId}): ${match.enclosingScope.astKind}`,
						);
					}
					locatorByUnit.set(unit, ids);
					await builder.appendBlock(unit, match.relativePath, lines.join("\n"));
				}
				if (result.matches.length === 0) await builder.appendRequiredBlock("no matches", "No structural matches");
				for (const [index, diagnostic] of result.diagnostics.entries()) {
					await builder.appendBlock(
						undefined,
						`diagnostic-${index}`,
						`diagnostic: ${diagnostic.relativePath} [${diagnostic.code}]: ${diagnostic.message}`,
					);
				}
				const summary = result.summary;
				const limits = [
					...(summary.resultLimitReached ? ["results"] : []),
					...(summary.fileLimitReached ? ["files"] : []),
					...(summary.sourceByteLimitReached ? ["source bytes"] : []),
					...(summary.depthLimitReached ? ["depth"] : []),
					...(summary.elapsedLimitReached ? ["elapsed time"] : []),
				];
				await builder.appendRequiredBlock(
					"structural search summary",
					[
						`summary: ${summary.filesDiscovered} discovered, ${summary.filesFiltered} filtered, ${summary.filesRead} read, ${summary.filesParsed} parsed, ${summary.filesSearched} searched`,
						`matches: ${summary.matchesFound} found, ${summary.matchesReturned} returned (limit ${summary.resultLimit}); source: ${formatSize(summary.sourceBytes)}; parser degraded: ${summary.parserDegradedFiles}`,
						`failures: ${summary.unreadableFiles} unreadable, ${summary.oversizedFiles} oversized, ${summary.failedFiles} failed; diagnostics omitted: ${summary.diagnosticsOmitted}`,
						`prefilters: literal=${summary.literalPrefilterApplied ? "yes" : "no"}, node-kind=${summary.potentialKindPrefilterApplied ? "yes" : "no"}; limits reached: ${limits.join(", ") || "none"}`,
					].join("\n"),
				);
				const bounded = await builder.finish();
				if (!bounded.overflow.fullOutputComplete) {
					const visible = new Set(bounded.visibleUnitIds);
					for (const [unit, ids] of locatorByUnit) {
						if (!visible.has(unit)) for (const id of ids) locators.delete(id);
					}
				}
				if (bounded.overflow.temporaryPath) orientation.recordTemporaryOutput(bounded.overflow.temporaryPath);
				const returnedBytes = Buffer.byteLength(bounded.content);
				return {
					content: [{ type: "text", text: bounded.content }],
					details: {
						kind: "astSearch",
						result,
						declarationCount: summary.matchesReturned,
						sourceBytes: summary.sourceBytes,
						returnedBytes,
						avoidedBytes: Math.max(0, summary.sourceBytes - returnedBytes),
						truncated: bounded.overflow.truncated,
						overflow: bounded.overflow,
					},
				};
			} catch (error) {
				await builder.abort();
				for (const ids of locatorByUnit.values()) for (const id of ids) locators.delete(id);
				throw error;
			}
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const options = `[${args.language ?? "infer"} limit=${args.resultLimit}]`;
			const component =
				(context.lastComponent as AstCallComponent | undefined) ??
				new AstCallComponent(
					rowState,
					context.toolCallId,
					"ast_search",
					[stripLeadingAt(args.path)],
					[options],
					theme,
				);
			component.set([stripLeadingAt(args.path)], [options], theme);
			return component;
		},
		renderResult(result, options, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			return renderAstResult(result, options.expanded, theme, context);
		},
	});

	function relationshipTool(name: RelationshipOperation, description: string, guideline: string) {
		return defineTool<typeof relationshipParams, AstToolDetails>({
			name,
			label: name,
			description,
			promptSnippet: description,
			promptGuidelines: [guideline, "Inspect ambiguous candidate locators before selecting an edit target."],
			parameters: relationshipParams,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const path = await realpath(resolveExplorePath(ctx.cwd, params.path));
				if (!(await stat(path)).isDirectory()) throw new Error(`${name} requires a directory scope`);
				const record = locators.get(params.locator);
				if (!record)
					throw new Error(`Unknown declaration locator: ${params.locator}. Run outline or api_discover again.`);
				if (record.stale || record.generation !== client.getGeneration()) {
					throw new Error(`Declaration locator ${params.locator} is stale. Run outline or api_discover again.`);
				}
				const result = await client.relationships(path, record.token, name, params.resultLimit, signal);
				const builder = new BoundedTextResultBuilder(temporaryOutput, "completeBlocks");
				const locatorByUnit = new Map<string, number[]>();
				try {
					for (const [index, relationship] of result.relationships.entries()) {
						const sourcePath = resolve(path, relationship.relativePath);
						const targetId =
							relationship.targetLocator === record.token
								? record.id
								: registerLocator(
										relationship.targetLocator,
										relationship.targetPath,
										`${relationship.relationshipKind} target`,
									);
						const candidateIds = relationship.candidateLocators.map((token, candidateIndex) =>
							token === record.token
								? record.id
								: registerLocator(
										token,
										relationship.candidatePaths[candidateIndex] ?? relationship.targetPath,
										"relationship candidate",
									),
						);
						const scopeId = registerLocator(
							relationship.enclosingScope.locator,
							sourcePath,
							relationship.enclosingScope.qualifiedIdentity,
						);
						const ids = [targetId, ...candidateIds, scopeId];
						const unit = `${relationship.relativePath}:${relationship.range.startByte}:${index}`;
						locatorByUnit.set(unit, ids);
						const lines = [
							`${relationship.relativePath}:${displayLineRange(relationship.range)} [${relationship.relationshipKind}, ${relationship.certainty}, ${relationship.classification}]`,
							`  target (${targetId}); enclosing ${displayLineRange(relationship.enclosingScope.range)}(${scopeId}): ${relationship.enclosingScope.qualifiedIdentity}`,
						];
						if (relationship.certainty === "ambiguous") {
							lines.push(
								`  candidates: ${candidateIds.map((id) => `(${id})`).join(", ")}${relationship.competingCandidatesOmitted ? `; ${relationship.competingCandidatesOmitted} omitted` : ""}`,
							);
						}
						if (relationship.certaintyReason) lines.push(`  uncertainty: ${relationship.certaintyReason}`);
						await builder.appendBlock(unit, relationship.relativePath, lines.join("\n"));
					}
					if (result.relationships.length === 0)
						await builder.appendRequiredBlock("no relationships", `No direct ${name} found`);
					const summary = result.summary;
					const limits = [
						...(summary.resultLimitReached ? ["results"] : []),
						...(summary.fileLimitReached ? ["files"] : []),
						...(summary.sourceByteLimitReached ? ["source bytes"] : []),
						...(summary.depthLimitReached ? ["depth"] : []),
						...(summary.elapsedLimitReached ? ["elapsed time"] : []),
					];
					await builder.appendRequiredBlock(
						"relationship summary",
						`summary: ${summary.filesScanned} files scanned, ${summary.relationshipsFound} found, ${summary.relationshipsReturned} returned, ${summary.ambiguousRelationships} ambiguous; source: ${formatSize(summary.sourceBytes)}; parser degraded: ${summary.parserDegradedFiles}; diagnostics: ${summary.diagnostics}; limits reached: ${limits.join(", ") || "none"}`,
					);
					const bounded = await builder.finish();
					if (!bounded.overflow.fullOutputComplete) {
						const visible = new Set(bounded.visibleUnitIds);
						for (const [unit, ids] of locatorByUnit)
							if (!visible.has(unit)) for (const id of ids) if (id !== record.id) locators.delete(id);
					}
					if (bounded.overflow.temporaryPath) orientation.recordTemporaryOutput(bounded.overflow.temporaryPath);
					const returnedBytes = Buffer.byteLength(bounded.content);
					return {
						content: [{ type: "text", text: bounded.content }],
						details: {
							kind: "relationship",
							result,
							declarationCount: summary.relationshipsReturned,
							sourceBytes: summary.sourceBytes,
							returnedBytes,
							avoidedBytes: Math.max(0, summary.sourceBytes - returnedBytes),
							truncated: bounded.overflow.truncated,
							overflow: bounded.overflow,
						},
					};
				} catch (error) {
					await builder.abort();
					for (const ids of locatorByUnit.values())
						for (const id of ids) if (id !== record.id) locators.delete(id);
					throw error;
				}
			},
			renderCall(args, theme, context) {
				rowState.watch(context.toolCallId, context.invalidate);
				const component =
					(context.lastComponent as AstCallComponent | undefined) ??
					new AstCallComponent(
						rowState,
						context.toolCallId,
						name,
						[stripLeadingAt(args.path)],
						[`[${args.locator} limit=${args.resultLimit}]`],
						theme,
					);
				component.set([stripLeadingAt(args.path)], [`[${args.locator} limit=${args.resultLimit}]`], theme);
				return component;
			},
			renderResult(result, options, theme, context) {
				rowState.watch(context.toolCallId, context.invalidate);
				return renderAstResult(result, options.expanded, theme, context);
			},
		});
	}

	const references = relationshipTool(
		"references",
		"Find direct references and type usages for a declaration locator.",
		"Use references to inspect direct repository usage and re-exports.",
	);
	const callers = relationshipTool(
		"callers",
		"Find direct callers for a declaration locator.",
		"Use callers for syntactic call sites; inferred dispatch is labelled.",
	);
	const callees = relationshipTool(
		"callees",
		"Find direct callees inside a declaration locator.",
		"Use callees to inspect direct dependencies of one executable scope.",
	);
	const implementations = relationshipTool(
		"implementations",
		"Find implementations and overrides for a declaration locator.",
		"Use implementations for syntactic inheritance and conservative same-name overrides.",
	);
	const tests = relationshipTool(
		"tests",
		"Find directly affected tests for a declaration locator.",
		"Use tests for direct references in standard test files and containers.",
	);

	return {
		outline,
		symbol,
		api_discover: apiDiscover,
		ast_search: astSearch,
		references,
		callers,
		callees,
		implementations,
		tests,
		clear() {
			locators.clear();
			nextLocator = 1;
			orientation.clear();
		},
		resetForTree() {
			locators.clear();
			nextLocator = 1;
			orientation.resetGate();
		},
		invalidate(paths: readonly string[]) {
			const changed = new Set(paths.map((path) => resolve(path)));
			for (const record of locators.values()) {
				if (changed.has(record.path)) record.stale = true;
			}
			orientation.invalidate(paths);
		},
	};
}

function formatApiQuery(query: ApiQuery): string {
	switch (query.kind) {
		case "exactName":
		case "prefixName":
		case "substringName":
		case "fuzzyName":
			return `${query.kind}=${query.name}`;
		case "declarationKind":
			return `kind=${query.declarationKind}`;
		case "documentation":
			return `docs=${query.terms.join(",")}`;
	}
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
	const fixed = [
		...(args.recursive ? ["recursive"] : []),
		...(args.includePrivate ? ["private"] : []),
		...(args.includeDocs ? ["docs"] : []),
	];
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
