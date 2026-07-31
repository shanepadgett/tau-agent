import { lstat } from "node:fs/promises";
import type { ExploreEngine } from "../engine.ts";
import type { Decl, DeclKind, FileIr } from "../ir.ts";
import { filterDeclForest, walkDecls } from "../query.ts";
import { scanSources, type ScanOutcome } from "../scan.ts";
import { docsText, signatureText } from "../slice.ts";
import { formatPathForDisplay, pathResolutionError, resolveExplorePath, walkPaths } from "../traverse.ts";

export type OutlineOptions = {
	includePrivate: boolean;
	includeDocs: boolean;
	/** Exact `name` / `qualifiedName` filter. Empty → no name filter. */
	names: readonly string[];
};

export type OutlineRow = {
	depth: number;
	startLine: number;
	endLine: number;
	kind: DeclKind;
	name: string;
	qualifiedName: string;
	/** Signature source slice (no body). */
	signature: string;
	/** Attached docs when `includeDocs` and a span exists. */
	docs: string | undefined;
};

export type OutlineFileView = {
	/** Absolute path. */
	path: string;
	languageId: string;
	parseDegraded: boolean;
	rows: OutlineRow[];
};

export type OutlineResult = { mode: "file"; file: OutlineFileView } | { mode: "directory"; files: OutlineFileView[] };

function keepVisibility(includePrivate: boolean): (decl: Decl) => boolean {
	if (includePrivate) return () => true;
	// Only file/type-private declarations are hidden. `internal` (pub(crate), Go
	// package scope, C#/Kotlin internal) is module-visible surface a caller needs.
	return (decl) => decl.visibility !== "private";
}

/** Keep decls that match a name, or ancestors of a match (structure preserved). */
function filterByNames(decls: readonly Decl[], names: ReadonlySet<string>): Decl[] {
	const out: Decl[] = [];
	for (const decl of decls) {
		const selfMatch = names.has(decl.name) || names.has(decl.qualifiedName);
		if (selfMatch) {
			out.push(decl);
			continue;
		}
		const children = filterByNames(decl.children, names);
		if (children.length > 0) out.push({ ...decl, children });
	}
	return out;
}

function prepareDecls(ir: FileIr, options: OutlineOptions): Decl[] {
	let decls = filterDeclForest(ir.decls, keepVisibility(options.includePrivate));
	if (options.names.length > 0) {
		decls = filterByNames(decls, new Set(options.names));
	}
	return decls;
}

function outlineFromIr(ir: FileIr, source: string, options: OutlineOptions): OutlineFileView {
	const decls = prepareDecls(ir, options);
	const rows: OutlineRow[] = [];
	walkDecls(decls, (decl, depth) => {
		rows.push({
			depth,
			startLine: decl.startLine,
			endLine: decl.endLine,
			kind: decl.kind,
			name: decl.name,
			qualifiedName: decl.qualifiedName,
			signature: signatureText(decl, source),
			docs: options.includeDocs ? docsText(decl, source) : undefined,
		});
	});
	return {
		path: ir.path,
		languageId: ir.languageId,
		parseDegraded: ir.parseDegraded,
		rows,
	};
}

/** Multi-file: keep files with rows, or degraded parses (diagnostic only). */
function keepMultiFileView(view: OutlineFileView): boolean {
	return view.rows.length > 0 || view.parseDegraded;
}

async function outlineAbsoluteFile(
	engine: ExploreEngine,
	absolutePath: string,
	options: OutlineOptions,
): Promise<OutlineFileView> {
	const source = await engine.sourceForFile(absolutePath);
	return outlineFromIr(source.ir, source.source, options);
}

/** Ignore-aware one-level file list. Intentional shallow walk — maxDepth limit is not a failure. */
async function listSupportedFilesOneLevel(
	engine: ExploreEngine,
	directory: string,
	signal: AbortSignal,
): Promise<string[]> {
	const walk = await walkPaths({
		cwd: engine.cwd,
		root: directory,
		filesOnly: true,
		includeRoot: false,
		budgets: { maxDepth: 1 },
		signal,
		matchFile: (hit) => engine.registry.adapterForPath(hit.absolutePath) !== undefined,
	});
	if (walk.limit === "cancelled" || signal.aborted) {
		throw new Error("outline cancelled");
	}
	return walk.entries
		.filter((hit) => hit.depth === 1 && hit.type === "file")
		.map((hit) => hit.absolutePath)
		.sort((a, b) => a.localeCompare(b));
}

/**
 * File or one-level directory outline (non-recursive).
 * Recursive streaming lives in the tool (complete-block emission).
 */
export async function outlinePath(
	engine: ExploreEngine,
	pathInput: string,
	options: OutlineOptions,
	signal: AbortSignal,
): Promise<OutlineResult> {
	signal.throwIfAborted();
	const absolutePath = resolveExplorePath(engine.cwd, pathInput);
	let stats;
	try {
		stats = await lstat(absolutePath);
	} catch (error) {
		throw pathResolutionError(error, pathInput);
	}

	if (stats.isDirectory()) {
		const paths = await listSupportedFilesOneLevel(engine, absolutePath, signal);
		const files: OutlineFileView[] = [];
		for (const filePath of paths) {
			signal.throwIfAborted();
			const view = await outlineAbsoluteFile(engine, filePath, options);
			if (keepMultiFileView(view)) files.push(view);
		}
		return { mode: "directory", files };
	}

	if (!stats.isFile()) {
		throw new Error(`Not a file or directory: ${formatPathForDisplay(absolutePath, engine.cwd)}`);
	}
	if (engine.registry.adapterForPath(absolutePath) === undefined) {
		throw new Error(`Unsupported language for path: ${formatPathForDisplay(absolutePath, engine.cwd)}`);
	}
	const file = await outlineAbsoluteFile(engine, absolutePath, options);
	return { mode: "file", file };
}

/**
 * Stream recursive outline file units. Yields IR+bytes together (one source read per file).
 * Return value is the scan outcome (limits / counters).
 */
export async function* outlineRecursive(
	engine: ExploreEngine,
	pathInput: string,
	options: OutlineOptions,
	signal: AbortSignal,
): AsyncGenerator<OutlineFileView, ScanOutcome> {
	signal.throwIfAborted();
	const absolutePath = resolveExplorePath(engine.cwd, pathInput);
	let stats;
	try {
		stats = await lstat(absolutePath);
	} catch (error) {
		throw pathResolutionError(error, pathInput);
	}
	if (!stats.isDirectory()) {
		throw new Error("recursive outline requires a directory target");
	}

	const scan = scanSources({ engine, cwd: engine.cwd, root: absolutePath, signal });
	let step = await scan.next();
	while (!step.done) {
		signal.throwIfAborted();
		const view = outlineFromIr(step.value.ir, step.value.source, options);
		if (keepMultiFileView(view)) yield view;
		step = await scan.next();
	}
	const outcome = step.value;
	if (outcome.limit === "cancelled" || signal.aborted) {
		throw new Error("outline cancelled");
	}
	return outcome;
}
