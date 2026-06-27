import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { defineTool, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { type SearchEvidenceDetails, withSearchEvidence } from "./evidence.ts";
import { displayPath } from "./path-utils.ts";
import { formatStatus, type SearchRenderState, toolHeader } from "./render-state.ts";
import { runRipgrep } from "./ripgrep.ts";

const grepParams = Type.Object({
	queries: Type.Array(Type.Array(Type.String({ description: "One rg argv item." })), {
		description: "Batched rg-style argv arrays.",
	}),
	limit: Type.Optional(Type.Number({ description: "Maximum shown match/context lines." })),
	maxPerFile: Type.Optional(Type.Number({ description: "Maximum shown lines per file per query." })),
	maxLineLength: Type.Optional(Type.Number({ description: "Visible characters per matched line." })),
	contextOnly: Type.Optional(Type.Boolean({ description: "Show context lines only." })),
});

type GrepParams = Static<typeof grepParams>;
type GrepDetails = SearchEvidenceDetails;

const NATIVE_FLAGS = new Set([
	"--json",
	"-l",
	"--files-with-matches",
	"-L",
	"--files-without-match",
	"-c",
	"--count",
	"-o",
	"--only-matching",
	"-q",
	"--quiet",
	"--files",
	"--vimgrep",
	"--column",
	"--null",
	"-0",
	"--byte-offset",
]);

export function registerGrepTool(pi: ExtensionAPI, renderState: SearchRenderState): void {
	pi.registerTool(
		defineTool<typeof grepParams, GrepDetails>({
			name: "grep",
			label: "grep",
			description: "Run batched rg-style content searches with compact grouped output.",
			promptSnippet: "grep file contents with batched rg-style queries",
			promptGuidelines: [
				"Use grep for file-content discovery; batch related content searches in one grep call.",
				"Use multiple -e patterns inside one grep query when paths and flags match.",
				"Use multiple grep query arrays when paths or flags differ.",
				"Use grep limits, globs, and paths instead of bash rg | head | awk | cut | wc.",
				"Use grep --no-ignore or -u only with narrow paths or globs for ignored content.",
			],
			parameters: grepParams,
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				const limit = Math.max(1, Math.floor(params.limit ?? 100));
				const maxPerFile = Math.max(1, Math.floor(params.maxPerFile ?? 8));
				const maxLineLength = Math.max(20, Math.floor(params.maxLineLength ?? 200));
				const perQuery = fairShares(params.queries.length, limit);
				const blocks: string[] = [];
				const evidencePaths = new Set<string>();

				for (let index = 0; index < params.queries.length; index += 1) {
					const query = params.queries[index] ?? [];
					const native = shouldPassthrough(query);
					const result = await runRipgrep(
						native ? query : ["--json", "--line-number", "--with-filename", ...query],
						{ cwd: ctx.cwd, signal },
					);
					if (result.exitCode === null || (result.exitCode !== 0 && result.exitCode !== 1))
						return errorResult(`rg failed for query ${index + 1}:\n${result.stderr || "unknown error"}`);
					if (native) {
						blocks.push(result.stdout || result.stderr || `[query ${index + 1}: no output]`);
						continue;
					}
					const formatted = await formatCompactGrep(ctx.cwd, result.stdout, {
						queryIndex: index + 1,
						limit: perQuery[index] ?? 0,
						maxPerFile,
						maxLineLength,
						contextOnly: params.contextOnly === true,
					});
					for (const path of formatted.paths) evidencePaths.add(path);
					blocks.push(formatted.text);
				}

				const text = blocks.filter(Boolean).join("\n");
				return {
					content: [{ type: "text", text: text || "No matches found" }],
					details: withSearchEvidence(undefined, {
						version: 1,
						kind: "grep",
						role: "navigation",
						paths: [...evidencePaths],
						complete: true,
						toolCallId,
					}),
				};
			},
			renderCall(args, theme, context) {
				return new GrepCall(args, theme, context.toolCallId, renderState);
			},
			renderResult(result, { expanded }, _theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(expanded ? textContent(result.content) : "");
				return text;
			},
		}),
	);
}

async function formatCompactGrep(
	cwd: string,
	stdout: string,
	options: { queryIndex: number; limit: number; maxPerFile: number; maxLineLength: number; contextOnly: boolean },
): Promise<{ text: string; paths: string[] }> {
	const events = stdout
		.split("\n")
		.flatMap(parseRgEvent)
		.filter((event) => event.type === "match" || event.type === "context");
	const groups = events.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
	const perFile = new Map<string, number>();
	const selected: RgLine[] = [];
	const paths = new Set<string>();
	let shown = 0;
	for (const event of groups) {
		if (shown >= options.limit) break;
		if (options.contextOnly && event.type !== "context") continue;
		const count = perFile.get(event.path) ?? 0;
		if (count >= options.maxPerFile) continue;
		perFile.set(event.path, count + 1);
		shown += 1;
		paths.add(event.path);
		selected.push(event);
	}
	const pathList = [...paths];
	const labels = pathLabels(cwd, pathList);
	const lineCounts = await fileLineCounts(cwd, pathList);
	const lines = labels.base ? [`base ${labels.base}`] : [];
	let currentPath: string | undefined;
	for (const event of selected) {
		const sep = event.type === "context" ? "-" : ":";
		if (event.path !== currentPath) {
			const lineCount = lineCounts.get(event.path);
			lines.push(
				`${labels.names.get(event.path) ?? event.path}${lineCount === undefined ? "" : ` (${lineCount} lines)`}`,
			);
			currentPath = event.path;
		}
		lines.push(`  ${event.line}${sep} ${truncateLine(event.text, event.matchStart, options.maxLineLength)}`);
	}
	const omitted = Math.max(0, groups.length - shown);
	lines.push(`[q${options.queryIndex}: ${shown}/${groups.length} shown, ${omitted} omitted, ${paths.size} files]`);
	return { text: lines.join("\n"), paths: [...paths] };
}

interface RgLine {
	type: "match" | "context";
	path: string;
	line: number;
	text: string;
	matchStart: number;
}
function parseRgEvent(line: string): RgLine[] {
	if (!line) return [];
	const parsed = JSON.parse(line) as unknown;
	if (!isRgEvent(parsed)) return [];
	const text = parsed.data.lines.text.replace(/\n$/, "");
	const matchStart = parsed.type === "match" ? (parsed.data.submatches[0]?.start ?? 0) : 0;
	return [{ type: parsed.type, path: parsed.data.path.text, line: parsed.data.line_number, text, matchStart }];
}

function isRgEvent(value: unknown): value is {
	type: "match" | "context";
	data: { path: { text: string }; line_number: number; lines: { text: string }; submatches: Array<{ start: number }> };
} {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		((value as { type: unknown }).type === "match" || (value as { type: unknown }).type === "context")
	);
}

function shouldPassthrough(query: string[]): boolean {
	return query.some(
		(arg) =>
			NATIVE_FLAGS.has(arg) ||
			arg.includes("help") ||
			arg.includes("version") ||
			arg.includes("null") ||
			arg.includes("byte-offset"),
	);
}

function truncateLine(text: string, matchStart: number, max: number): string {
	if (text.length <= max) return text;
	const start = Math.max(0, matchStart - Math.floor(max / 2));
	const end = Math.min(text.length, start + max);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

async function fileLineCounts(cwd: string, paths: string[]): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	for (const path of paths) {
		const content = await readFile(resolve(cwd, path), "utf8").catch(() => undefined);
		if (content !== undefined) counts.set(path, content.split("\n").length - (content.endsWith("\n") ? 1 : 0));
	}
	return counts;
}

function pathLabels(cwd: string, paths: string[]): { base: string | undefined; names: Map<string, string> } {
	const names = new Map(paths.map((path) => [path, displayPath(cwd, resolve(cwd, path))]));
	if (paths.length < 2 || paths.some((path) => !isAbsolute(path))) return { base: undefined, names };
	const base = commonDirectory(paths);
	if (base === undefined) return { base: undefined, names };
	return {
		base,
		names: new Map(paths.map((path) => [path, relative(base, path)])),
	};
}

function commonDirectory(paths: string[]): string | undefined {
	let parts = dirname(paths[0] ?? "").split("/");
	for (const path of paths.slice(1)) {
		const nextParts = dirname(path).split("/");
		let index = 0;
		while (index < parts.length && parts[index] === nextParts[index]) index += 1;
		parts = parts.slice(0, index);
	}
	const base = parts.join("/") || "/";
	return base === "/" ? undefined : `${base}/`;
}

function fairShares(count: number, limit: number): number[] {
	if (count <= 0) return [];
	const base = Math.floor(limit / count);
	let extra = limit % count;
	return Array.from({ length: count }, () => base + (extra-- > 0 ? 1 : 0));
}

function errorResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: {
			searchEvidence: {
				version: 1 as const,
				kind: "grep" as const,
				role: "navigation" as const,
				paths: [],
				complete: false,
			},
		},
		isError: true,
	};
}

function textContent(content: readonly { type: string }[]): string {
	for (const item of content) {
		if (isTextContent(item)) return item.text;
	}
	return "";
}

function isTextContent(content: { type: string }): content is { type: "text"; text: string } {
	return content.type === "text" && "text" in content && typeof content.text === "string";
}

class GrepCall implements Component {
	private readonly args: GrepParams;
	private readonly theme: Theme;
	private readonly toolCallId: string;
	private readonly state: SearchRenderState;

	constructor(args: GrepParams, theme: Theme, toolCallId: string, state: SearchRenderState) {
		this.args = args;
		this.theme = theme;
		this.toolCallId = toolCallId;
		this.state = state;
	}
	render(width: number): string[] {
		const queries = Array.isArray(this.args.queries) ? this.args.queries : [];
		const queryText = queries.map((query) => query.join(" ")).join(", ");
		return wrapTextWithAnsi(
			`${toolHeader(this.theme, "grep")}${formatStatus(this.theme, this.state, this.toolCallId)} ${this.theme.fg("muted", queryText)}`,
			width,
		);
	}
	invalidate(): void {}
}
