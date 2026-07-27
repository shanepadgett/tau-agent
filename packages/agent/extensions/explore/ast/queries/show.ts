import type { ExploreEngine } from "../engine.ts";
import type { Candidate, Target } from "../identity.ts";
import { resolveTarget } from "../identity.ts";
import type { Decl, FileIr, ImportRef } from "../ir.ts";
import { declarationText, signatureText, signatureWithDocsText } from "../slice.ts";
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

const NO_IMPORT_NOISE: ReadonlySet<string> = new Set();

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

function identifiersIn(text: string, noise: ReadonlySet<string>): Set<string> {
	const out = new Set<string>();
	for (const match of text.matchAll(IDENTIFIER)) {
		const id = match[0];
		if (id !== undefined && !noise.has(id)) out.add(id);
	}
	return out;
}

/** Exact import statement text from adapter byte span. Noise set is language-owned. */
function importStatementsFor(
	declText: string,
	imports: readonly ImportRef[],
	source: string,
	noise: ReadonlySet<string>,
): string[] {
	const declIds = identifiersIn(declText, noise);
	const seenSpans = new Set<string>();
	const out: string[] = [];
	for (const importRef of imports) {
		const spanKey = `${importRef.startOffset}:${importRef.endOffset}`;
		if (seenSpans.has(spanKey)) continue;
		const statement = source.slice(importRef.startOffset, importRef.endOffset).replace(/\s+$/u, "");
		if (statement.length === 0) continue;
		const hit = [...identifiersIn(statement, noise)].some((id) => declIds.has(id));
		if (!hit) continue;
		seenSpans.add(spanKey);
		out.push(statement);
	}
	return out;
}

function lineRanges(source: string): { start: number; end: number }[] {
	const ranges: { start: number; end: number }[] = [];
	let start = 0;
	for (let i = 0; i < source.length; i += 1) {
		if (source.charCodeAt(i) === 10) {
			ranges.push({ start, end: i });
			start = i + 1;
		}
	}
	if (start < source.length || source.length === 0) {
		ranges.push({ start, end: source.length });
	}
	return ranges;
}

function sliceLines(source: string, startLine: number, endLine: number): string {
	const ranges = lineRanges(source);
	if (ranges.length === 0) return "";
	const lo = Math.max(1, startLine);
	const hi = Math.min(ranges.length, endLine);
	if (hi < lo) return "";
	const start = ranges[lo - 1];
	const end = ranges[hi - 1];
	if (start === undefined || end === undefined) return "";
	return source.slice(start.start, end.end);
}

function buildBlock(
	decl: Decl,
	path: string,
	ir: FileIr,
	source: string,
	view: ShowView,
	contextLines: number,
	importNoise: ReadonlySet<string>,
): ShowBlock {
	const warnings: string[] = [];
	let text: string;
	let startLine = decl.startLine;
	let endLine = decl.endLine;

	switch (view) {
		case "signature": {
			text = signatureText(decl, source);
			break;
		}
		case "signatureWithDocs": {
			if (decl.docStartOffset === undefined || decl.docEndOffset === undefined) {
				warnings.push("no attached documentation");
				text = signatureText(decl, source);
			} else {
				text = signatureWithDocsText(decl, source);
			}
			break;
		}
		case "declaration": {
			if (contextLines > 0) {
				startLine = Math.max(1, decl.startLine - contextLines);
				endLine = Math.min(Math.max(ir.lineCount, decl.endLine), decl.endLine + contextLines);
				text = sliceLines(source, startLine, endLine);
			} else {
				text = declarationText(decl, source);
			}
			break;
		}
		case "declarationWithImports": {
			const declText = declarationText(decl, source);
			const importBlocks = importStatementsFor(declText, ir.imports, source, importNoise);
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

		const adapter = engine.registry.adapterForPath(resolution.path);
		const importNoise = adapter?.importNoiseIdentifiers ?? NO_IMPORT_NOISE;
		const block = buildBlock(
			resolution.decl,
			resolution.path,
			resolution.ir,
			resolution.source,
			view,
			context,
			importNoise,
		);
		if (docsWarningEmitted) {
			block.warnings = block.warnings.filter((warning) => warning !== "no attached documentation");
		} else if (block.warnings.includes("no attached documentation")) {
			docsWarningEmitted = true;
		}
		blocks.push(block);
	}

	return { blocks };
}
