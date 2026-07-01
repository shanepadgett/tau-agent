import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import { divideBudget, normalizeCountLimit, normalizeNonNegativeInteger } from "./limits.ts";
import {
	formatPathForDisplay,
	isWithinPath,
	pathResolutionError,
	resolveExplorePath,
	stripLeadingAt,
	toSlashPath,
} from "./path-display.ts";
import { createExploreTextResult, type ExploreTextDetails, expandedExploreText } from "./result.ts";

const grepQueryParams = Type.Object(
	{
		patterns: Type.Array(Type.String(), { minItems: 1 }),
		paths: Type.Optional(Type.Array(Type.String())),
		include: Type.Optional(Type.Array(Type.String())),
		exclude: Type.Optional(Type.Array(Type.String())),
		regex: Type.Optional(Type.Boolean()),
		case: Type.Optional(Type.Union([Type.Literal("smart"), Type.Literal("sensitive"), Type.Literal("insensitive")])),
		word: Type.Optional(Type.Boolean()),
		context: Type.Optional(Type.Number()),
		hidden: Type.Optional(Type.Boolean()),
		noIgnore: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const grepParams = Type.Object(
	{
		queries: Type.Array(grepQueryParams, { minItems: 1 }),
		limit: Type.Optional(Type.Number()),
		maxPerFile: Type.Optional(Type.Number()),
		maxLineLength: Type.Optional(Type.Number()),
		contextOnly: Type.Optional(Type.Boolean()),
		stopAfterLimit: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export type GrepParams = Static<typeof grepParams>;
type GrepQuery = Static<typeof grepQueryParams>;

interface RgMatch {
	absolutePath: string;
	displayPath: string;
	lineNumber: number;
	text: string;
	matchIndex: number;
	matchLength: number;
}

interface FileMatchCount {
	absolutePath: string;
	displayPath: string;
	matchCount: number;
}

interface SelectedFile extends FileMatchCount {
	take: number;
	omittedInFile: number;
}

interface RenderedLine {
	lineNumber: number;
	kind: "match" | "context";
	text: string;
	matchIndex?: number;
	matchLength?: number;
}

interface GrepFileGroup {
	displayPath: string;
	lineCount?: number;
	lines: RenderedLine[];
	omittedInFile: number;
}

interface GrepQueryOutput {
	groups: GrepFileGroup[];
	omittedByLimit: number;
	limit: number;
	maxPerFile: number;
	stoppedAfterLimit: boolean;
}

const STDERR_LIMIT = 16_384;
const NOISE_PATH_NAMES = [
	".git",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".cache",
	".next",
	".turbo",
	".parcel-cache",
	"out",
];

function normalizeMaxLineLength(value: number | undefined): number {
	return Math.max(20, normalizeCountLimit(value, 200));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStructuredParams(value: unknown): asserts value is GrepParams {
	if (!isRecord(value) || !Array.isArray(value.queries)) throw new Error("grep requires structured queries");
	if (value.queries.some(Array.isArray)) {
		throw new Error("grep queries must be structured objects; raw argv arrays are not supported");
	}
}

function normalizedGlob(pattern: string): string {
	return toSlashPath(stripLeadingAt(pattern));
}

function pushNoiseExcludes(args: string[]): void {
	for (const name of NOISE_PATH_NAMES) {
		args.push("--glob", `!${name}`);
		args.push("--glob", `!${name}/**`);
		args.push("--glob", `!**/${name}`);
		args.push("--glob", `!**/${name}/**`);
	}
}

function buildRgArgs(query: GrepQuery, searchPaths: readonly string[]): string[] {
	const args = ["--json", "--line-number", "--color=never", "--no-heading", "--no-require-git"];
	if (query.regex !== true) args.push("--fixed-strings");
	if (query.case === "insensitive") args.push("--ignore-case");
	else if (query.case === undefined || query.case === "smart") args.push("--smart-case");
	if (query.word === true) args.push("--word-regexp");
	if (query.hidden === true) args.push("--hidden");
	if (query.noIgnore === true) args.push("--no-ignore");
	for (const pattern of query.include ?? []) args.push("--glob", normalizedGlob(pattern));
	for (const pattern of query.exclude ?? []) args.push("--glob", `!${normalizedGlob(pattern)}`);
	if (query.noIgnore !== true) pushNoiseExcludes(args);
	for (const pattern of query.patterns) args.push("-e", pattern);
	args.push("--", ...searchPaths);
	return args;
}

async function resolveSearchPaths(cwd: string, query: GrepQuery): Promise<string[]> {
	const inputs = query.paths && query.paths.length > 0 ? query.paths : ["."];
	const paths: string[] = [];
	for (const input of inputs) {
		const absolutePath = resolveExplorePath(cwd, input);
		await lstat(absolutePath).catch((error: unknown) => {
			throw pathResolutionError(error, input);
		});
		paths.push(absolutePath);
	}
	return dedupeSearchPaths(paths);
}

function dedupeSearchPaths(paths: readonly string[]): string[] {
	const deduped: string[] = [];
	for (const path of [...new Set(paths)].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
		if (deduped.some((kept) => isWithinPath(kept, path))) continue;
		deduped.push(path);
	}
	return deduped;
}

function textField(value: unknown): string | undefined {
	return isRecord(value) && typeof value.text === "string" ? value.text : undefined;
}

function byteOffsetToStringIndex(text: string, byteOffset: number): number {
	return Buffer.from(text).subarray(0, byteOffset).toString().length;
}

function sanitizeLineText(text: string): string {
	return text.replace(/\r?\n$/, "").replace(/\r$/, "");
}

function matchRange(lineText: string, data: Record<string, unknown>): { index: number; length: number } {
	const submatches = Array.isArray(data.submatches) ? data.submatches : [];
	let first: { start: number; end: number } | undefined;
	for (const submatch of submatches) {
		if (!isRecord(submatch) || typeof submatch.start !== "number" || typeof submatch.end !== "number") continue;
		if (!first || submatch.start < first.start) first = { start: submatch.start, end: submatch.end };
	}
	if (!first) return { index: 0, length: 1 };
	const index = byteOffsetToStringIndex(lineText, first.start);
	const end = byteOffsetToStringIndex(lineText, first.end);
	return { index, length: Math.max(1, end - index) };
}

function parseRgMatch(line: string, cwd: string): RgMatch | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || parsed.type !== "match" || !isRecord(parsed.data)) return undefined;
	const data = parsed.data;
	const pathText = textField(data.path);
	const lineText = textField(data.lines);
	if (!pathText || lineText === undefined || typeof data.line_number !== "number") return undefined;
	const text = sanitizeLineText(lineText);
	const absolutePath = resolve(cwd, pathText);
	const range = matchRange(text, data);
	return {
		absolutePath,
		displayPath: formatPathForDisplay(absolutePath, cwd),
		lineNumber: data.line_number,
		text,
		matchIndex: range.index,
		matchLength: range.length,
	};
}

function errorCode(error: Error): unknown {
	return "code" in error ? error.code : undefined;
}

async function runRipgrep(
	cwd: string,
	args: readonly string[],
	signal: AbortSignal | undefined,
	onMatch: (match: RgMatch) => boolean,
): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}

		const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		if (!child.stdout || !child.stderr) {
			reject(new Error("Failed to run ripgrep: stdout/stderr unavailable"));
			return;
		}

		const lines = createInterface({ input: child.stdout });
		let stderr = "";
		let settled = false;
		let aborted = false;
		let killedByLimit = false;

		const settle = (done: () => void): void => {
			if (settled) return;
			settled = true;
			done();
		};
		const cleanup = (): void => {
			lines.close();
			signal?.removeEventListener("abort", onAbort);
		};
		const stopChild = (): void => {
			if (!child.killed) {
				killedByLimit = true;
				child.kill();
			}
		};
		const onAbort = (): void => {
			aborted = true;
			if (!child.killed) child.kill();
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		child.stderr.on("data", (chunk: Buffer) => {
			const remaining = STDERR_LIMIT - stderr.length;
			if (remaining > 0) stderr += chunk.toString("utf8").slice(0, remaining);
		});
		lines.on("line", (line) => {
			const match = parseRgMatch(line, cwd);
			if (!match) return;
			if (!onMatch(match)) stopChild();
		});
		child.on("error", (error: Error) => {
			cleanup();
			const message =
				errorCode(error) === "ENOENT" ? "ripgrep (rg) is not available" : `Failed to run ripgrep: ${error.message}`;
			settle(() => reject(new Error(message)));
		});
		child.on("close", (code) => {
			cleanup();
			if (aborted) {
				settle(() => reject(new Error("Operation aborted")));
				return;
			}
			if (!killedByLimit && code !== 0 && code !== 1) {
				const message = stderr.trim() || `ripgrep exited with code ${code ?? "unknown"}`;
				settle(() => reject(new Error(message)));
				return;
			}
			settle(resolvePromise);
		});
	});
}

async function countMatches(cwd: string, query: GrepQuery, signal: AbortSignal | undefined): Promise<FileMatchCount[]> {
	const searchPaths = await resolveSearchPaths(cwd, query);
	const counts = new Map<string, FileMatchCount>();
	await runRipgrep(cwd, buildRgArgs(query, searchPaths), signal, (match) => {
		const count = counts.get(match.absolutePath) ?? {
			absolutePath: match.absolutePath,
			displayPath: match.displayPath,
			matchCount: 0,
		};
		count.matchCount += 1;
		counts.set(match.absolutePath, count);
		return true;
	});
	return [...counts.values()].sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

function selectFiles(
	counts: readonly FileMatchCount[],
	limit: number,
	maxPerFile: number,
): {
	selected: SelectedFile[];
	omittedByLimit: number;
} {
	let remaining = limit;
	let eligibleMatches = 0;
	let displayedMatches = 0;
	const selected: SelectedFile[] = [];
	for (const count of counts) {
		const eligibleInFile = Math.min(count.matchCount, maxPerFile);
		eligibleMatches += eligibleInFile;
		const take = Math.min(eligibleInFile, remaining);
		if (take > 0) {
			displayedMatches += take;
			remaining -= take;
			selected.push({ ...count, take, omittedInFile: Math.max(0, count.matchCount - maxPerFile) });
		}
	}
	return { selected, omittedByLimit: Math.max(0, eligibleMatches - displayedMatches) };
}

async function collectSelectedMatches(
	cwd: string,
	query: GrepQuery,
	selected: readonly SelectedFile[],
	signal: AbortSignal | undefined,
): Promise<Map<string, RgMatch[]>> {
	const selectedByPath = new Map(selected.map((file) => [file.absolutePath, file]));
	const matchesByPath = new Map<string, RgMatch[]>();
	let remaining = selected.reduce((sum, file) => sum + file.take, 0);
	if (remaining === 0) return matchesByPath;
	await runRipgrep(
		cwd,
		buildRgArgs(
			query,
			selected.map((file) => file.absolutePath),
		),
		signal,
		(match) => {
			const file = selectedByPath.get(match.absolutePath);
			if (!file) return true;
			const matches = matchesByPath.get(match.absolutePath) ?? [];
			if (matches.length >= file.take) return remaining > 0;
			matches.push(match);
			matchesByPath.set(match.absolutePath, matches);
			remaining -= 1;
			return remaining > 0;
		},
	);
	return matchesByPath;
}

async function readLines(absolutePath: string): Promise<string[] | undefined> {
	try {
		return (await readFile(absolutePath, "utf8")).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	} catch {
		return undefined;
	}
}

function buildRenderedLines(
	fileLines: readonly string[] | undefined,
	matches: readonly RgMatch[],
	context: number,
	contextOnly: boolean,
): RenderedLine[] {
	const matchByLine = new Map(matches.map((match) => [match.lineNumber, match]));
	const wanted = new Map<number, RenderedLine["kind"]>();
	for (const match of matches) {
		const start = Math.max(1, match.lineNumber - context);
		const end = Math.max(start, match.lineNumber + context);
		for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
			if (matchByLine.has(lineNumber)) {
				if (!contextOnly) wanted.set(lineNumber, "match");
			} else if (fileLines?.[lineNumber - 1] !== undefined && !wanted.has(lineNumber)) {
				wanted.set(lineNumber, "context");
			}
		}
	}

	return [...wanted.entries()]
		.sort(([a], [b]) => a - b)
		.map(([lineNumber, kind]) => {
			const match = matchByLine.get(lineNumber);
			return {
				lineNumber,
				kind,
				text: fileLines?.[lineNumber - 1] ?? match?.text ?? "",
				matchIndex: match?.matchIndex,
				matchLength: match?.matchLength,
			};
		});
}

function truncateLineText(line: RenderedLine, maxLineLength: number): string {
	if (line.text.length <= maxLineLength) return line.text;
	if (line.kind === "context" || line.matchIndex === undefined) return `${line.text.slice(0, maxLineLength - 1)}…`;
	const matchLength = line.matchLength ?? 1;
	const side = Math.max(0, Math.floor((maxLineLength - matchLength) / 2));
	let start = Math.max(0, line.matchIndex - side);
	if (start + maxLineLength > line.text.length) start = Math.max(0, line.text.length - maxLineLength);
	const end = Math.min(line.text.length, start + maxLineLength);
	return `${start > 0 ? "…" : ""}${line.text.slice(start, end)}${end < line.text.length ? "…" : ""}`;
}

function renderGrepOutput(output: GrepQueryOutput, maxLineLength: number): string {
	const lines: string[] = [];
	for (const group of output.groups) {
		const lineCount = group.lineCount === undefined ? "" : ` (${group.lineCount} lines)`;
		lines.push(`${group.displayPath}${lineCount}`);
		for (const line of group.lines) {
			lines.push(`${line.lineNumber}${line.kind === "match" ? ":" : "-"} ${truncateLineText(line, maxLineLength)}`);
		}
		if (group.omittedInFile > 0) {
			lines.push(`… omitted ${group.omittedInFile} matches in file (maxPerFile ${output.maxPerFile})`);
		}
	}
	if (output.stoppedAfterLimit) lines.push(`… stopped after ${output.limit} matches (limit ${output.limit})`);
	else if (output.omittedByLimit > 0) lines.push(`… omitted ${output.omittedByLimit} matches (limit ${output.limit})`);
	return lines.length === 0 ? "No matches" : lines.join("\n");
}

async function executeGrepQuery(
	cwd: string,
	query: GrepQuery,
	limit: number,
	maxPerFile: number,
	contextOnly: boolean,
	signal: AbortSignal | undefined,
	stopAfterLimit: boolean,
): Promise<GrepQueryOutput> {
	if (query.patterns.length === 0) throw new Error("grep query requires at least one pattern");
	const context = normalizeNonNegativeInteger(query.context, 0);
	if (!stopAfterLimit) return executeQueryWithCounts(cwd, query, limit, maxPerFile, contextOnly, signal, context);

	const searchPaths = await resolveSearchPaths(cwd, query);
	const matchesByPath = new Map<string, RgMatch[]>();
	const omittedInFileByPath = new Map<string, number>();
	let remaining = limit;

	await runRipgrep(cwd, buildRgArgs(query, searchPaths), signal, (match) => {
		const matches = matchesByPath.get(match.absolutePath) ?? [];
		if (matches.length >= maxPerFile) {
			omittedInFileByPath.set(match.absolutePath, (omittedInFileByPath.get(match.absolutePath) ?? 0) + 1);
			return true;
		}
		matches.push(match);
		matchesByPath.set(match.absolutePath, matches);
		remaining -= 1;
		return remaining > 0;
	});

	const groups: GrepFileGroup[] = [];
	for (const [absolutePath, matches] of matchesByPath) {
		const group = await createGrepFileGroup(
			absolutePath,
			matches[0]?.displayPath ?? absolutePath,
			matches,
			context,
			contextOnly,
			omittedInFileByPath.get(absolutePath) ?? 0,
		);
		if (group) groups.push(group);
	}

	return { groups, omittedByLimit: 0, limit, maxPerFile, stoppedAfterLimit: remaining === 0 };
}

async function executeQueryWithCounts(
	cwd: string,
	query: GrepQuery,
	limit: number,
	maxPerFile: number,
	contextOnly: boolean,
	signal: AbortSignal | undefined,
	context: number,
): Promise<GrepQueryOutput> {
	const counts = await countMatches(cwd, query, signal);
	const selection = selectFiles(counts, limit, maxPerFile);
	const matchesByPath = await collectSelectedMatches(cwd, query, selection.selected, signal);
	const groups: GrepFileGroup[] = [];

	for (const file of selection.selected) {
		const group = await createGrepFileGroup(
			file.absolutePath,
			file.displayPath,
			matchesByPath.get(file.absolutePath) ?? [],
			context,
			contextOnly,
			file.omittedInFile,
		);
		if (group) groups.push(group);
	}

	return { groups, omittedByLimit: selection.omittedByLimit, limit, maxPerFile, stoppedAfterLimit: false };
}

async function createGrepFileGroup(
	absolutePath: string,
	displayPath: string,
	matches: readonly RgMatch[],
	context: number,
	contextOnly: boolean,
	omittedInFile: number,
): Promise<GrepFileGroup | undefined> {
	const sortedMatches = [...matches].sort((a, b) => a.lineNumber - b.lineNumber);
	if (sortedMatches.length === 0) return undefined;
	const fileLines = await readLines(absolutePath);
	const renderedLines = buildRenderedLines(fileLines, sortedMatches, context, contextOnly);
	if (renderedLines.length === 0) return undefined;
	return {
		displayPath,
		lineCount: fileLines?.length,
		lines: renderedLines,
		omittedInFile,
	};
}

function renderCallSummary(args: GrepParams | undefined): string {
	const queries = args?.queries ?? [];
	const limit = normalizeCountLimit(args?.limit, 100);
	const maxPerFile = normalizeCountLimit(args?.maxPerFile, 8);
	const maxLineLength = normalizeMaxLineLength(args?.maxLineLength);
	if (queries.length !== 1) {
		return `${queries.length} queries limit=${limit} maxPerFile=${maxPerFile} maxLineLength=${maxLineLength}`;
	}
	const query = queries[0];
	const patterns = query?.patterns?.join(",") ?? "";
	const paths = query?.paths?.map(stripLeadingAt).join(" ") || ".";
	const include = query?.include?.map(stripLeadingAt).join(",");
	const exclude = query?.exclude?.map(stripLeadingAt).join(",");
	const context = normalizeNonNegativeInteger(query?.context, 0);
	const flags = [
		query?.regex ? "regex" : "literal",
		query?.case ?? "smart",
		query?.word ? "word" : "",
		query?.hidden ? "hidden" : "",
		query?.noIgnore ? "noIgnore" : "",
		args?.contextOnly ? "contextOnly" : "",
		args?.stopAfterLimit ? "stopAfterLimit" : "",
	]
		.filter(Boolean)
		.join(" ");
	return [
		`patterns=${patterns}`,
		`paths=${paths}`,
		include ? `include=${include}` : "",
		exclude ? `exclude=${exclude}` : "",
		`context=${context}`,
		`limit=${limit}`,
		`maxPerFile=${maxPerFile}`,
		`maxLineLength=${maxLineLength}`,
		flags,
	]
		.filter(Boolean)
		.join(" ");
}

export function createGrepTool(rowState: ToolRowStateStore) {
	return defineTool<typeof grepParams, ExploreTextDetails | undefined>({
		name: "grep",
		label: "grep",
		description: "Search file contents with structured queries.",
		promptSnippet: "Search file contents. Use stopAfterLimit for broad searches when first matches are enough.",
		parameters: grepParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			assertStructuredParams(params);
			if (params.queries.length === 0) throw new Error("grep requires at least one query");
			const limit = normalizeCountLimit(params.limit, 100);
			const maxPerFile = normalizeCountLimit(params.maxPerFile, 8);
			const maxLineLength = normalizeMaxLineLength(params.maxLineLength);
			const budgets = divideBudget(limit, params.queries.length);
			const parts: string[] = [];
			for (let i = 0; i < params.queries.length; i += 1) {
				const query = params.queries[i];
				if (!query) continue;
				const budget = budgets[i] ?? limit;
				const output = await executeGrepQuery(
					ctx.cwd,
					query,
					budget,
					maxPerFile,
					params.contextOnly === true,
					signal,
					params.stopAfterLimit === true,
				);
				const rendered = renderGrepOutput(output, maxLineLength);
				parts.push(params.queries.length === 1 ? rendered : `query ${i + 1}\n${rendered}`);
			}
			return createExploreTextResult(parts.join("\n"));
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const title = formatToolRowTitle(rowState, context.toolCallId, "grep", theme);
			text.setText(`${title} ${theme.fg("muted", renderCallSummary(args))}`);
			return text;
		},
		renderResult(result, _options, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(context.expanded ? expandedExploreText(result) : "");
			return text;
		},
	});
}
