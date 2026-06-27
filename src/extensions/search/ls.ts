import { readdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { defineTool, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { withSearchEvidence } from "./evidence.ts";
import { displayPath, fairShares, gitIgnored, hasNoisePart, isHiddenPath, resolveSearchPath } from "./path-utils.ts";
import { formatStatus, type SearchRenderState, toolHeader } from "./render-state.ts";

const lsParams = Type.Object({
	paths: Type.Optional(Type.Array(Type.String())),
	depth: Type.Optional(Type.Number()),
	limit: Type.Optional(Type.Number()),
	all: Type.Optional(Type.Boolean()),
	long: Type.Optional(Type.Boolean()),
});

type LsParams = Static<typeof lsParams>;
interface LsEntry {
	path: string;
	kind: "dir" | "file";
	size: number;
	mtimeMs: number;
}
interface LsOmissions {
	hidden: number;
	noise: number;
	ignored: number;
}

export function registerLsTool(pi: ExtensionAPI, renderState: SearchRenderState): void {
	pi.registerTool(
		defineTool<typeof lsParams>({
			name: "ls",
			label: "ls",
			description: "List compact directory inventory for batched paths.",
			promptSnippet: "ls compact directory inventory",
			promptGuidelines: [
				"Use ls for directory inventory; batch related paths in one ls call.",
				"Use ls depth, limit, all, and long instead of bash ls/find/tree pipelines.",
				"Use ls all=true only with narrow paths for ignored, hidden, or noise content.",
			],
			parameters: lsParams,
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				const output = await buildLsOutput(ctx.cwd, params);
				return {
					content: [{ type: "text", text: output.text }],
					details: withSearchEvidence(undefined, {
						version: 1,
						kind: "ls",
						role: "inventory",
						paths: output.paths,
						complete: output.omitted === 0,
						toolCallId,
					}),
				};
			},
			renderCall(args, theme, context) {
				return new LsCall(args, theme, context.toolCallId, renderState);
			},
		}),
	);
}

export async function buildStartupWorkspaceMap(cwd: string, _signal?: AbortSignal): Promise<string> {
	try {
		const output = await buildLsOutput(cwd, { paths: ["."], depth: 3, limit: 140, all: false, long: false });
		const text = `Workspace map (startup; gitignored/noise omitted):\n${output.text}\nUse ls for deeper/current structure; use all=true only for narrow ignored/noise paths.`;
		return text.length <= 4096 ? text : `${text.slice(0, 4000)}\n[omitted startup map beyond budget]`;
	} catch (error) {
		return `Workspace map (startup; gitignored/noise omitted): unavailable (${error instanceof Error ? error.message : "unknown error"})`;
	}
}

async function buildLsOutput(
	cwd: string,
	params: LsParams,
): Promise<{ text: string; paths: string[]; omitted: number }> {
	const rawPaths = params.paths && params.paths.length > 0 ? params.paths : ["."];
	const depth = Math.min(3, Math.max(0, Math.floor(params.depth ?? 1)));
	const limit = Math.max(1, Math.floor(params.limit ?? 100));
	const perPath = fairShares(rawPaths.length, limit);
	const entries: LsEntry[] = [];
	const omissions: LsOmissions = { hidden: 0, noise: 0, ignored: 0 };
	for (let index = 0; index < rawPaths.length; index += 1) {
		const absolute = resolveSearchPath(cwd, rawPaths[index] ?? ".");
		if (!absolute) continue;
		await collect(cwd, absolute, depth, params.all === true, entries, omissions, perPath[index] ?? 0);
	}
	const shown = entries.slice(0, limit);
	const lines = formatEntries(shown, params.long === true);
	const omitted = Math.max(0, entries.length - shown.length);
	if (omitted > 0) lines.push(`[omitted ${omitted} entries]`);
	if (omissions.hidden || omissions.noise || omissions.ignored)
		lines.push(`[omitted hidden ${omissions.hidden}, noise ${omissions.noise}, gitignored ${omissions.ignored}]`);
	return { text: lines.join("\n") || "[empty]", paths: shown.map((entry) => entry.path), omitted };
}

async function collect(
	cwd: string,
	absolute: string,
	depth: number,
	all: boolean,
	out: LsEntry[],
	omissions: LsOmissions,
	cap: number,
): Promise<void> {
	if (out.length >= cap) return;
	const info = await stat(absolute).catch(() => undefined);
	if (!info) {
		out.push({ path: displayPath(cwd, absolute), kind: "file", size: 0, mtimeMs: 0 });
		return;
	}
	const path = displayPath(cwd, absolute);
	if (!info.isDirectory()) {
		out.push({ path, kind: "file", size: info.size, mtimeMs: info.mtimeMs });
		return;
	}
	out.push({ path, kind: "dir", size: info.size, mtimeMs: info.mtimeMs });
	if (depth <= 0) return;
	const children = (await readdir(absolute, { withFileTypes: true })).sort(
		(left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name),
	);
	const childRels = children.map((child) => displayPath(cwd, resolve(absolute, child.name)));
	const ignored = all ? new Set<string>() : await gitIgnored(cwd, childRels);
	for (const child of children) {
		const childAbsolute = resolve(absolute, child.name);
		const rel = displayPath(cwd, childAbsolute);
		if (!all && isHiddenPath(rel)) {
			omissions.hidden += 1;
			continue;
		}
		if (!all && hasNoisePart(rel)) {
			omissions.noise += 1;
			continue;
		}
		if (!all && ignored.has(rel)) {
			omissions.ignored += 1;
			continue;
		}
		await collect(cwd, childAbsolute, depth - 1, all, out, omissions, cap);
	}
}

function formatEntries(entries: LsEntry[], long: boolean): string[] {
	const lines: string[] = [];
	let current = "";
	for (const entry of entries) {
		const dir = entry.kind === "dir" ? entry.path : dirname(entry.path);
		if (dir !== current) {
			current = dir;
			lines.push(`${dir}/`);
		}
		if (entry.kind === "file")
			lines.push(
				long
					? `  ${basename(entry.path)} ${entry.size}b ${new Date(entry.mtimeMs).toISOString()}`
					: `  ${basename(entry.path)}`,
			);
	}
	return lines;
}

class LsCall implements Component {
	private readonly args: LsParams;
	private readonly theme: Theme;
	private readonly toolCallId: string;
	private readonly state: SearchRenderState;

	constructor(args: LsParams, theme: Theme, toolCallId: string, state: SearchRenderState) {
		this.args = args;
		this.theme = theme;
		this.toolCallId = toolCallId;
		this.state = state;
	}
	render(width: number): string[] {
		const paths = Array.isArray(this.args.paths) ? this.args.paths : ["."];
		return wrapTextWithAnsi(
			`${toolHeader(this.theme, "ls")}${formatStatus(this.theme, this.state, this.toolCallId)} ${this.theme.fg("muted", `${paths.join(",")} depth=${this.args.depth ?? 1} limit=${this.args.limit ?? 100}`)}`,
			width,
		);
	}
	invalidate(): void {}
}
