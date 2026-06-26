import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import {
	createGrepToolDefinition,
	createReadToolDefinition,
	defineTool,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { splitLines, textContent } from "./memory-messages.ts";
import { GrepCallComponent, ReadCallComponent, type WorkingMemoryRenderState } from "./renderers.ts";
import { normalizeWorkingMemoryPath } from "./repo-scope.ts";

export const WORKING_MEMORY_GUIDANCE = [
	"Working memory prunes only outbound model context; raw session history and /tree stay intact.",
	"Search first, stay inside task boundaries, then read relevant repo-owned work files wholly with no offset or limit.",
	"Never use partial read for repo-owned work files. If a repo-owned work file is too large, search first or ask before reading slices.",
	"Use partial read only for external docs, dependencies, vendor/generated files, or non-work huge files where full content is wasteful.",
	"Grep output is temporary navigation evidence. After you read the files that matter, old grep output can be superseded.",
	"Before every final response after tool use, call forget for successful exploration that the next turn does not need.",
	"Use forget paths for irrelevant file evidence and recent for successful navigation/check outputs; keep only active facts in the checkpoint.",
	"For forgotten files, record when each should be reread with a concrete rereadIf condition.",
	"After mutations, rely on reread/path update evidence unless broader current context is required.",
];

const readParams = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(
		Type.Number({
			description: "Line number to start reading from (1-indexed). Do not use for repo-owned work files.",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum number of lines to read. Do not use for repo-owned work files." }),
	),
});

const grepParams = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

const forgetParams = Type.Object({
	keep: Type.String({ description: "Short checkpoint to retain after cleanup; include only facts needed next turn." }),
	paths: Type.Optional(
		Type.Array(
			Type.Object({
				path: Type.String({ description: "Path evidence to forget." }),
				rereadIf: Type.Optional(
					Type.String({ description: "Concrete condition for rereading this path, e.g. 'changing auth wiring'." }),
				),
			}),
		),
	),
	recent: Type.Optional(
		Type.Number({ description: "Forget this many recent eligible successful non-mutation results." }),
	),
});

export interface ForgetDetails {
	workingMemory: {
		version: 2;
		type: "forget";
		paths?: Array<{ path: string; rereadIf?: string }>;
		recent?: number;
	};
}

export function registerWorkingMemoryTools(pi: ExtensionAPI, renderState: WorkingMemoryRenderState): void {
	pi.registerTool({
		name: "read",
		label: "Read",
		description:
			"Read the contents of a file. For repo-owned work files, read the whole file with no offset or limit. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For external docs, dependencies, vendor/generated files, or non-work huge files, offset/limit may be used. Text output is truncated to 2000 lines or 50KB (whichever is hit first).",
		promptSnippet: "Read file contents",
		promptGuidelines: [
			"Use read to examine files instead of cat or sed.",
			"Use read with no offset or limit for repo-owned work files.",
			"Do not use offset or limit on repo-owned work files; partial reads are only for external docs, dependencies, vendor/generated files, or non-work huge files.",
		],
		parameters: readParams,
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return createReadToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			return new ReadCallComponent(args, theme, context.toolCallId, renderState);
		},
	});

	pi.registerTool({
		name: "grep",
		label: "grep",
		description:
			"Search file contents for a pattern. Returns matching lines with file paths and line numbers. Appends compact [loc: path:lineCount] metadata for matched files when available.",
		promptSnippet:
			"Search file contents for patterns (respects .gitignore); grep may append [loc: path:lineCount] for matched files",
		promptGuidelines: [
			"Use grep for broad content search across directories before reading files.",
			"After grep, read the matched repo-owned files that matter wholly when practical.",
		],
		parameters: grepParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await createGrepToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
			return appendGrepLocFooter(result, params, ctx.cwd);
		},
		renderCall(args, theme, context) {
			return new GrepCallComponent(args, theme, context.toolCallId, renderState);
		},
	});

	pi.registerTool(
		defineTool<typeof forgetParams, ForgetDetails>({
			name: "forget",
			label: "Forget",
			description:
				"Retain a short working-memory checkpoint and stub prior successful evidence that is no longer needed.",
			promptSnippet: "Forget irrelevant working-memory evidence while keeping a short checkpoint",
			promptGuidelines: [
				"Use forget before your final response after broad grep/read/bash exploration once surviving facts fit in keep.",
				"Use paths for irrelevant file evidence and recent for successful non-mutation results that no longer need raw output.",
				"For path evidence, include a concrete rereadIf condition, such as 'if changing command registration'.",
				"Never forget user requirements, active decisions, mutation results, failed checks, or unresolved errors.",
			],
			parameters: forgetParams,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				const paths = params.paths
					?.filter((entry) => entry.path.trim().length > 0)
					.map((entry) => ({
						path: entry.path,
						...(entry.rereadIf?.trim() ? { rereadIf: entry.rereadIf.trim() } : {}),
					}));
				return {
					content: [{ type: "text", text: `Working memory retained:\n${params.keep}` }],
					details: {
						workingMemory: {
							version: 2,
							type: "forget",
							...(paths && paths.length > 0 ? { paths } : {}),
							...(typeof params.recent === "number" ? { recent: params.recent } : {}),
						},
					},
				};
			},
		}),
	);
}

async function appendGrepLocFooter(
	result: Awaited<ReturnType<ReturnType<typeof createGrepToolDefinition>["execute"]>>,
	params: { path?: string },
	cwd: string,
) {
	const text = textContent(result.content);
	if (!text || text === "No matches found") return result;
	const footer = await grepLocFooter(text, params.path, cwd);
	if (!footer) return result;
	return { ...result, content: [{ type: "text" as const, text: `${text}\n${footer}` }] };
}

async function grepLocFooter(
	text: string,
	rawSearchPath: string | undefined,
	cwd: string,
): Promise<string | undefined> {
	const searchPath = normalizeWorkingMemoryPath(cwd, rawSearchPath ?? ".");
	if (!searchPath) return undefined;
	const searchPathIsDirectory = await stat(searchPath)
		.then((value) => value.isDirectory())
		.catch(() => undefined);
	if (searchPathIsDirectory === undefined) return undefined;
	const entries: string[] = [];
	for (const path of grepOutputPaths(text)) {
		const absolutePath = searchPathIsDirectory ? resolve(searchPath, path) : searchPath;
		const lineCount = await readFileLineCount(absolutePath);
		if (lineCount !== undefined) entries.push(`${path}:${lineCount}`);
	}
	return entries.length > 0 ? `[loc: ${entries.join(", ")}]` : undefined;
}

function grepOutputPaths(text: string): string[] {
	const paths = new Set<string>();
	for (const line of text.split("\n")) {
		if (line.startsWith("[") || line.trim() === "") continue;
		const match = /^(.+?)(?::\d+:|-\d+- )/.exec(line);
		if (match?.[1]) paths.add(match[1]);
	}
	return [...paths];
}

async function readFileLineCount(path: string): Promise<number | undefined> {
	const text = await readFile(path, "utf8").catch(() => undefined);
	if (text === undefined) return undefined;
	return splitLines(text).length;
}

export function normalizeGrepOutputPath(
	cwd: string,
	rawSearchPath: unknown,
	rawOutputPath: unknown,
): string | undefined {
	if (typeof rawOutputPath !== "string") return undefined;
	const outputPath = rawOutputPath.trim();
	if (!outputPath) return undefined;
	if (isAbsolute(outputPath)) return resolve(outputPath);
	const searchPath = normalizeWorkingMemoryPath(cwd, rawSearchPath ?? ".");
	if (!searchPath) return normalizeWorkingMemoryPath(cwd, outputPath);
	if (!outputPath.includes("/") && basename(searchPath) === outputPath) return searchPath;
	return resolve(searchPath, outputPath);
}
