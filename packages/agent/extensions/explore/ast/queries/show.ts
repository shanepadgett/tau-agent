import type { ExploreEngine } from "../engine.ts";
import type { Candidate, Target } from "../identity.ts";
import { resolveTarget } from "../identity.ts";
import type { Decl, FileIr, ImportRef } from "../ir.ts";
import { declarationText, signatureText, signatureWithDocsText, type SourceBytes, utf8Slice } from "../slice.ts";
import { formatPathForDisplay, stripLeadingAt } from "../../traverse.ts";

export type ShowView = "signature" | "signatureWithDocs" | "declaration" | "declarationWithImports";

export type ShowTargetInput = {
	path: string;
	name: string;
	line?: number;
};

export type ShowBlock = {
	path: string;
	name: string;
	qualifiedName: string;
	startLine: number;
	endLine: number;
	text: string;
	/** Real warnings only (e.g. no docs for signatureWithDocs). */
	warnings: string[];
};

export type ShowBatch = {
	blocks: ShowBlock[];
};

const IDENTIFIER = /[A-Za-z_$][\w$]*/gu;

const NOISE_IDENTIFIERS = new Set([
	"abstract",
	"as",
	"async",
	"await",
	"boolean",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"declare",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"from",
	"function",
	"get",
	"if",
	"implements",
	"import",
	"in",
	"infer",
	"instanceof",
	"interface",
	"keyof",
	"let",
	"module",
	"namespace",
	"new",
	"null",
	"number",
	"of",
	"package",
	"private",
	"protected",
	"public",
	"readonly",
	"return",
	"satisfies",
	"set",
	"static",
	"string",
	"super",
	"switch",
	"symbol",
	"this",
	"throw",
	"true",
	"try",
	"type",
	"typeof",
	"undefined",
	"unique",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"func",
	"go",
	"map",
	"chan",
	"defer",
	"fallthrough",
	"goto",
	"range",
	"select",
	"struct",
	"iota",
	"any",
	"error",
	"int",
	"int32",
	"int64",
	"uint",
	"byte",
	"rune",
	"float64",
	"bool",
]);

function targetKey(target: ShowTargetInput): string {
	const line = target.line === undefined ? "" : String(target.line);
	return `${stripLeadingAt(target.path)}\0${target.name}\0${line}`;
}

/** Dedupe identical path+name+line targets, preserving first-seen order. */
function dedupeShowTargets(targets: readonly ShowTargetInput[]): ShowTargetInput[] {
	const seen = new Set<string>();
	const out: ShowTargetInput[] = [];
	for (const target of targets) {
		const key = targetKey(target);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			path: stripLeadingAt(target.path),
			name: target.name,
			...(target.line === undefined ? {} : { line: target.line }),
		});
	}
	return out;
}

function identifiersIn(text: string): Set<string> {
	const out = new Set<string>();
	for (const match of text.matchAll(IDENTIFIER)) {
		const id = match[0];
		if (id !== undefined && !NOISE_IDENTIFIERS.has(id)) out.add(id);
	}
	return out;
}

/** Exact import statement text from adapter byte span. Dedupe shared Go block spans. */
function importStatementsFor(declText: string, imports: readonly ImportRef[], bytes: SourceBytes): string[] {
	const declIds = identifiersIn(declText);
	const seenSpans = new Set<string>();
	const out: string[] = [];
	for (const importRef of imports) {
		const spanKey = `${importRef.startByte}:${importRef.endByte}`;
		if (seenSpans.has(spanKey)) continue;
		const statement = utf8Slice(bytes, importRef.startByte, importRef.endByte).replace(/\s+$/u, "");
		if (statement.length === 0) continue;
		const hit = [...identifiersIn(statement)].some((id) => declIds.has(id));
		if (!hit) continue;
		seenSpans.add(spanKey);
		out.push(statement);
	}
	return out;
}

function lineByteRanges(bytes: SourceBytes): { start: number; end: number }[] {
	const ranges: { start: number; end: number }[] = [];
	let start = 0;
	for (let i = 0; i < bytes.length; i += 1) {
		if (bytes[i] === 10) {
			ranges.push({ start, end: i });
			start = i + 1;
		}
	}
	if (start < bytes.length || bytes.length === 0) {
		ranges.push({ start, end: bytes.length });
	}
	return ranges;
}

function sliceLines(bytes: SourceBytes, startLine: number, endLine: number): string {
	const ranges = lineByteRanges(bytes);
	if (ranges.length === 0) return "";
	const lo = Math.max(1, startLine);
	const hi = Math.min(ranges.length, endLine);
	if (hi < lo) return "";
	const start = ranges[lo - 1];
	const end = ranges[hi - 1];
	if (start === undefined || end === undefined) return "";
	return utf8Slice(bytes, start.start, end.end);
}

function buildBlock(
	decl: Decl,
	path: string,
	ir: FileIr,
	bytes: SourceBytes,
	view: ShowView,
	contextLines: number,
): ShowBlock {
	const warnings: string[] = [];
	let text: string;
	let startLine = decl.startLine;
	let endLine = decl.endLine;

	switch (view) {
		case "signature": {
			text = signatureText(decl, bytes);
			break;
		}
		case "signatureWithDocs": {
			if (decl.docStartByte === undefined || decl.docEndByte === undefined) {
				warnings.push("no attached documentation");
				text = signatureText(decl, bytes);
			} else {
				text = signatureWithDocsText(decl, bytes);
			}
			break;
		}
		case "declaration": {
			if (contextLines > 0) {
				startLine = Math.max(1, decl.startLine - contextLines);
				endLine = Math.min(Math.max(ir.lineCount, decl.endLine), decl.endLine + contextLines);
				text = sliceLines(bytes, startLine, endLine);
			} else {
				text = declarationText(decl, bytes);
			}
			break;
		}
		case "declarationWithImports": {
			const declText = declarationText(decl, bytes);
			const importBlocks = importStatementsFor(declText, ir.imports, bytes);
			text = importBlocks.length > 0 ? `${importBlocks.join("\n")}\n\n${declText}` : declText;
			break;
		}
	}

	return {
		path,
		name: decl.name,
		qualifiedName: decl.qualifiedName,
		startLine,
		endLine,
		text,
		warnings,
	};
}

function formatCandidateError(label: string, candidates: readonly Candidate[], cwd: string): string {
	const lines = [
		`Ambiguous target ${label}:`,
		...candidates.map((candidate) => {
			const path = formatPathForDisplay(candidate.path, cwd);
			const range =
				candidate.startLine === candidate.endLine
					? `L${candidate.startLine}`
					: `L${candidate.startLine}-${candidate.endLine}`;
			const sig = candidate.signature.replace(/\s+/gu, " ").trim();
			return `${path}:${range} ${candidate.kind} ${candidate.qualifiedName} — ${sig}`;
		}),
	];
	return lines.join("\n");
}

/**
 * Resolve every target before emitting. Any missing/ambiguous target fails the whole batch.
 * `contextLines` must be omitted (undefined) unless view is declaration.
 */
export async function showTargets(
	engine: ExploreEngine,
	targets: readonly ShowTargetInput[],
	view: ShowView,
	contextLines: number | undefined,
	signal: AbortSignal,
): Promise<ShowBatch> {
	if (contextLines !== undefined && view !== "declaration") {
		throw new Error("contextLines is supported only with view=declaration");
	}
	const context = contextLines ?? 0;

	const unique = dedupeShowTargets(targets);
	const blocks: ShowBlock[] = [];
	let docsWarningEmitted = false;

	for (const target of unique) {
		signal.throwIfAborted();
		const resolutionTarget: Target = {
			path: target.path,
			name: target.name,
			...(target.line === undefined ? {} : { line: target.line }),
		};
		const resolution = await resolveTarget(engine, engine.cwd, resolutionTarget, signal);
		const label =
			target.line === undefined
				? `${target.name} @ ${target.path}`
				: `${target.name} @ ${target.path}:${target.line}`;

		if (resolution.kind === "notFound") {
			throw new Error(`No declaration matched ${label}`);
		}
		if (resolution.kind === "candidates") {
			throw new Error(formatCandidateError(label, resolution.candidates, engine.cwd));
		}

		const block = buildBlock(resolution.decl, resolution.path, resolution.ir, resolution.bytes, view, context);
		if (docsWarningEmitted) {
			block.warnings = block.warnings.filter((warning) => warning !== "no attached documentation");
		} else if (block.warnings.includes("no attached documentation")) {
			docsWarningEmitted = true;
		}
		blocks.push(block);
	}

	return { blocks };
}
