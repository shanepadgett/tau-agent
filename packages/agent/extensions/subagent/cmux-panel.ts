import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SubagentDetails } from "./run.ts";

const execFileAsync = promisify(execFile);
const WRITE_DEBOUNCE_MS = 150;
const CLOSE_DELAY_MS = 2000;
const CMUX_TIMEOUT_MS = 2500;

/** Open subagent markdown surfaces, oldest → newest. First splits right of parent; later split down under first. */
const openSurfaces: string[] = [];
/**
 * Live panels by surface id.
 * cmux blanks sibling markdown views when any one close-surface runs mid-batch,
 * so we keep finished panels open until every live panel is done, then tear down together.
 */
const livePanels = new Map<
	string,
	{
		path: string;
		directory: string;
		last: SubagentDetails;
		done: boolean;
	}
>();
/** Serialize every cmux open/close so layout and CLI never race. */
let opChain = Promise.resolve();

export interface CmuxSubagentPanel {
	update(details: SubagentDetails, immediate?: boolean): void;
	/** Flush final content. Surface stays until all sibling panels are done. */
	close(details: SubagentDetails): Promise<void>;
}

function available(): boolean {
	return Boolean(process.env.CMUX_WORKSPACE_ID && process.env.CMUX_SURFACE_ID);
}

async function cmux(args: string[]): Promise<{ ok: true; stdout: string } | { ok: false }> {
	try {
		const result = await execFileAsync("cmux", args, {
			timeout: CMUX_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
			env: process.env,
		});
		return { ok: true, stdout: result.stdout };
	} catch {
		return { ok: false };
	}
}

function cap(text: string | undefined, limit: number): string {
	if (!text) return "";
	const normalized = text.replace(/\r\n/g, "\n").trimEnd();
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, limit - 1)}…`;
}

export function formatSubagentPanelMarkdown(details: SubagentDetails): string {
	const identity = details.threadId ? `${details.agent} · ${details.threadId}` : details.agent;
	const lines = [
		`# ${identity}`,
		"",
		`\`${details.status}${details.phase ? ` · ${details.phase}` : ""}\` · tools ${details.toolCalls} · ${(details.durationMs / 1000).toFixed(1)}s`,
		`model ${details.model} · thinking ${details.thinkingLevel}`,
		"",
		"## Task",
		"",
		cap(details.task, 1200) || "_(empty)_",
	];
	if (details.currentActivity) {
		lines.push("", "## Current", "", cap(details.currentActivity, 400));
	}
	if (details.actions.length > 0) {
		lines.push("", "## Actions", "");
		for (const action of details.actions.slice(-12)) {
			const mark = action.error ? "!" : "·";
			lines.push(`- ${mark} ${cap(action.summary, 200)}`);
		}
		if (details.omittedActions > 0) {
			lines.push(`- _${details.omittedActions} earlier actions omitted_`);
		}
	}
	if (details.response) {
		lines.push("", "## Response", "", cap(details.response, 3000));
	}
	if (details.error) {
		lines.push("", "## Error", "", cap(details.error, 800));
	}
	lines.push("");
	return lines.join("\n");
}

function enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
	const next = opChain.then(fn, fn);
	opChain = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

async function writeAtomic(path: string, content: string): Promise<void> {
	const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
	await rename(temp, path);
}

/** Close every live panel together. Only safe when none are still running. */
async function teardownAllPanels(): Promise<void> {
	const entries = [...livePanels.entries()];
	livePanels.clear();
	openSurfaces.length = 0;
	for (const [surfaceId, panel] of entries) {
		await cmux(["close-surface", "--surface", surfaceId]);
		await rm(panel.directory, { recursive: true, force: true }).catch(() => undefined);
	}
	if (entries.length > 0) await cmux(["rpc", "workspace.equalize_splits", "{}"]);
}

function scheduleTeardownIfIdle(): void {
	if (livePanels.size === 0) return;
	if (![...livePanels.values()].every((panel) => panel.done)) return;
	void enqueueOp(async () => {
		// Re-check after queueing — a new panel may have opened.
		if (livePanels.size === 0) return;
		if (![...livePanels.values()].every((panel) => panel.done)) return;
		await new Promise((resolve) => setTimeout(resolve, CLOSE_DELAY_MS));
		if (livePanels.size === 0) return;
		if (![...livePanels.values()].every((panel) => panel.done)) return;
		await teardownAllPanels();
	});
}

export async function openCmuxSubagentPanel(options: {
	agent: string;
	threadId: string;
	task: string;
	details: SubagentDetails;
}): Promise<CmuxSubagentPanel | undefined> {
	if (!available()) return undefined;

	return enqueueOp(async () => {
		const ping = await cmux(["ping"]);
		if (!ping.ok) return undefined;

		let directory: string | undefined;
		let path: string | undefined;
		let surfaceId: string | undefined;
		let closed = false;
		let writeTimer: ReturnType<typeof setTimeout> | undefined;
		let writeChain = Promise.resolve();
		let pending: SubagentDetails | undefined;

		try {
			directory = await mkdtemp(join(tmpdir(), "tau-subagent-panel-"));
			path = join(directory, `${options.agent}-${options.threadId}.md`);
			await writeAtomic(path, formatSubagentPanelMarkdown(options.details));

			const parentSurface = process.env.CMUX_SURFACE_ID;
			if (!parentSurface) return undefined;
			const first = openSurfaces.length === 0;
			const direction = first ? "right" : "down";
			const sourceSurface = first ? parentSurface : openSurfaces[0];
			if (!sourceSurface) return undefined;

			const opened = await cmux([
				"--json",
				"--id-format",
				"both",
				"markdown",
				"open",
				path,
				"--surface",
				sourceSurface,
				"--direction",
				direction,
				"--focus",
				"false",
			]);
			if (!opened.ok) {
				await rm(directory, { recursive: true, force: true }).catch(() => undefined);
				return undefined;
			}
			try {
				const parsed = JSON.parse(opened.stdout) as { surface_id?: string; surface_ref?: string };
				if (typeof parsed.surface_id === "string" && parsed.surface_id) surfaceId = parsed.surface_id;
				else if (typeof parsed.surface_ref === "string" && parsed.surface_ref) surfaceId = parsed.surface_ref;
			} catch {
				await rm(directory, { recursive: true, force: true }).catch(() => undefined);
				return undefined;
			}
			if (!surfaceId) {
				await rm(directory, { recursive: true, force: true }).catch(() => undefined);
				return undefined;
			}
			openSurfaces.push(surfaceId);
			livePanels.set(surfaceId, {
				path,
				directory,
				last: options.details,
				done: false,
			});
			await cmux(["rpc", "workspace.equalize_splits", "{}"]);
		} catch {
			if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
			return undefined;
		}

		const filePath = path;
		const panelSurface = surfaceId;

		const write = async (details: SubagentDetails) => {
			const entry = livePanels.get(panelSurface);
			if (entry) entry.last = details;
			await writeAtomic(filePath, formatSubagentPanelMarkdown(details));
		};

		const flush = (details: SubagentDetails) => {
			writeChain = writeChain.then(() => write(details)).catch(() => undefined);
			return writeChain;
		};

		const schedule = (details: SubagentDetails, immediate: boolean) => {
			pending = details;
			if (immediate) {
				if (writeTimer) {
					clearTimeout(writeTimer);
					writeTimer = undefined;
				}
				const snapshot = pending;
				pending = undefined;
				if (snapshot) void flush(snapshot);
				return;
			}
			if (writeTimer) return;
			writeTimer = setTimeout(() => {
				writeTimer = undefined;
				const snapshot = pending;
				pending = undefined;
				if (snapshot) void flush(snapshot);
			}, WRITE_DEBOUNCE_MS);
		};

		return {
			update(details, immediate = false) {
				if (closed) return;
				schedule(details, immediate);
			},
			async close(details) {
				if (closed) return;
				closed = true;
				if (writeTimer) {
					clearTimeout(writeTimer);
					writeTimer = undefined;
				}
				await flush(details);
				const entry = livePanels.get(panelSurface);
				if (entry) {
					entry.done = true;
					entry.last = details;
				}
				// Stay visible until every sibling is done — mid-batch close-surface blanks the rest.
				scheduleTeardownIfIdle();
			},
		};
	});
}
