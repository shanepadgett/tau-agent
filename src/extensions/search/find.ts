import { basename, dirname } from "node:path";
import { defineTool, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { type SearchEvidenceDetails, withSearchEvidence } from "./evidence.ts";
import { fairShares, matchesGlob } from "./path-utils.ts";
import { formatStatus, type SearchRenderState, toolHeader } from "./render-state.ts";
import { runRipgrep } from "./ripgrep.ts";

const findQuery = Type.Object({
	path: Type.Optional(Type.String()),
	patterns: Type.Optional(Type.Array(Type.String())),
	type: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("dir"), Type.Literal("any")])),
	maxDepth: Type.Optional(Type.Number()),
	noIgnore: Type.Optional(Type.Boolean()),
	hidden: Type.Optional(Type.Boolean()),
});
const findParams = Type.Object({ queries: Type.Array(findQuery), limit: Type.Optional(Type.Number()) });
type FindParams = Static<typeof findParams>;

export function registerFindTool(pi: ExtensionAPI, renderState: SearchRenderState): void {
	pi.registerTool(
		defineTool<typeof findParams, SearchEvidenceDetails>({
			name: "find",
			label: "find",
			description: "Discover files and directories with batched structured queries.",
			promptSnippet: "find filenames and paths with batched structured queries",
			promptGuidelines: [
				"Use find for filename or path discovery; batch related path searches in one find call.",
				"Use find parameters instead of bash find | head | awk | wc.",
				"Use find noIgnore or hidden only with narrow paths or patterns for ignored, hidden, or noise content.",
			],
			parameters: findParams,
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				const limit = Math.max(1, Math.floor(params.limit ?? 100));
				const shares = fairShares(params.queries.length, limit);
				const blocks: string[] = [];
				const evidence = new Set<string>();
				for (let index = 0; index < params.queries.length; index += 1) {
					const query = params.queries[index] ?? {};
					const args = ["--files"];
					if (query.hidden) args.push("--hidden");
					if (query.noIgnore) args.push("--no-ignore");
					if (typeof query.maxDepth === "number")
						args.push("--max-depth", String(Math.max(0, Math.floor(query.maxDepth))));
					args.push(query.path ?? ".");
					const result = await runRipgrep(args, { cwd: ctx.cwd, signal });
					if (result.exitCode === null || (result.exitCode !== 0 && result.exitCode !== 1))
						return {
							content: [
								{ type: "text" as const, text: `rg --files failed for query ${index + 1}:\n${result.stderr}` },
							],
							details: {
								searchEvidence: {
									version: 1,
									kind: "find",
									role: "navigation",
									paths: [],
									complete: false,
									toolCallId,
								},
							},
							isError: true,
						};
					const formatted = formatFind(
						result.stdout.split("\n").filter(Boolean),
						query,
						shares[index] ?? 0,
						index + 1,
					);
					for (const path of formatted.paths) evidence.add(path);
					blocks.push(formatted.text);
				}
				return {
					content: [{ type: "text", text: blocks.join("\n") || "No files found" }],
					details: withSearchEvidence(undefined, {
						version: 1,
						kind: "find",
						role: "navigation",
						paths: [...evidence],
						complete: true,
						toolCallId,
					}),
				};
			},
			renderCall(args, theme, context) {
				return new FindCall(args, theme, context.toolCallId, renderState);
			},
		}),
	);
}

function formatFind(
	files: string[],
	query: FindParams["queries"][number],
	limit: number,
	queryIndex: number,
): { text: string; paths: string[] } {
	const patterns = query.patterns ?? [];
	const type = query.type ?? "any";
	const all = new Set<string>();
	for (const file of files) {
		if (
			patterns.length > 0 &&
			!patterns.some((pattern) => matchesGlob(pattern.includes("/") ? file : basename(file), pattern))
		)
			continue;
		if (type !== "dir") all.add(file);
		if (type !== "file") all.add(dirname(file) === "." ? "." : dirname(file));
	}
	const paths = [...all].sort();
	const shown = paths.slice(0, limit);
	const lines: string[] = [];
	let current = "";
	for (const path of shown) {
		const dir = dirname(path);
		if (dir !== current) {
			current = dir;
			lines.push(`${dir}/`);
		}
		lines.push(`  ${basename(path)}`);
	}
	const exts = new Map<string, number>();
	for (const path of paths)
		exts.set(path.includes(".") ? path.slice(path.lastIndexOf(".")) : "[none]", (exts.get(path) ?? 0) + 1);
	lines.push(
		`[query ${queryIndex}: shown ${shown.length}/${paths.length}, omitted ${Math.max(0, paths.length - shown.length)}, dirs ${new Set(paths.map(dirname)).size}]`,
	);
	lines.push(
		`[ext: ${[...exts.entries()]
			.slice(0, 8)
			.map(([ext, count]) => `${ext} ${count}`)
			.join(", ")}]`,
	);
	return { text: lines.join("\n"), paths };
}

class FindCall implements Component {
	private readonly args: FindParams;
	private readonly theme: Theme;
	private readonly toolCallId: string;
	private readonly state: SearchRenderState;

	constructor(args: FindParams, theme: Theme, toolCallId: string, state: SearchRenderState) {
		this.args = args;
		this.theme = theme;
		this.toolCallId = toolCallId;
		this.state = state;
	}
	render(): string[] {
		const queryCount = Array.isArray(this.args.queries) ? this.args.queries.length : 0;
		return [
			`${toolHeader(this.theme, "find")}${formatStatus(this.theme, this.state, this.toolCallId)} ${this.theme.fg("muted", `${queryCount} queries limit=${this.args.limit ?? 100}`)}`,
		];
	}
	invalidate(): void {}
}
