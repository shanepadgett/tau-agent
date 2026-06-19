import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { onTauEvent } from "../../shared/events.ts";

interface FooterItem {
	id: string;
	priority: number;
	text: string;
}

interface GitSummary {
	branch: string;
	text: string;
}

interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	latestCacheHitRate: number | undefined;
	cost: number;
}

const COMMAND = "footer";
const USAGE = "Usage: /footer [on|off|refresh]";

export default function footerExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let activeCtx: ExtensionContext | undefined;
	let footerInstalled = false;
	let requestRender: (() => void) | undefined;
	let unsubscribeFooterItems: (() => void) | undefined;
	const gitByCwd = new Map<string, GitSummary | undefined>();
	let gitRefresh: Promise<void> | undefined;
	let dailyCost: number | undefined;
	let dailyRefresh: Promise<void> | undefined;
	const items = new Map<string, FooterItem>();

	function render(): void {
		requestRender?.();
	}

	function setActiveCtx(ctx: ExtensionContext): void {
		activeCtx = ctx;
		if (enabled && !footerInstalled) installFooter(ctx);
	}

	function installFooter(ctx: ExtensionContext): void {
		footerInstalled = true;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribeBranch = footerData.onBranchChange(() => {
				void refreshGit(ctx).then(render);
			});

			return {
				dispose() {
					unsubscribeBranch();
					if (requestRender) requestRender = undefined;
				},
				invalidate() {
					render();
				},
				render(width: number): string[] {
					if (!enabled) return [];
					const currentCtx = activeCtx ?? ctx;
					const git = gitByCwd.get(currentCtx.cwd);
					const model = currentCtx.model ? `${currentCtx.model.provider}/${currentCtx.model.id}` : "no-model";
					const thinking = pi.getThinkingLevel();
					const topLeft = [gitText(git), `${model} (${thinking})`].filter(Boolean).join(" • ");
					const sessionUsage = sessionCost(currentCtx);
					const session = formatCost(sessionUsage.cost);
					const daily = dailyCost === undefined ? "$?" : formatCost(dailyCost);
					const topRight = statsText(theme, currentCtx, sessionUsage, session, daily);
					const bottomLeft = [shortenPath(currentCtx.cwd), sessionName(currentCtx)].filter(Boolean).join(" • ");
					const bottomRight = [extensionStatusesText(footerData.getExtensionStatuses()), footerItemsText(items)]
						.filter(Boolean)
						.join(" • ");

					return [
						renderSplit(width, theme.fg("dim", topLeft), topRight),
						renderSplit(width, theme.fg("dim", bottomLeft), theme.fg("dim", bottomRight)),
					];
				},
			} satisfies Component & { dispose(): void; invalidate(): void };
		});
	}

	async function refreshGit(ctx: ExtensionContext): Promise<void> {
		if (gitRefresh) return gitRefresh;
		gitRefresh = (async () => {
			const result = await pi.exec(
				"git",
				["--no-optional-locks", "status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
				{ cwd: ctx.cwd, timeout: 1_000 },
			);
			gitByCwd.set(ctx.cwd, result.code === 0 ? parseGitStatus(result.stdout) : undefined);
		})()
			.catch(() => {
				gitByCwd.set(ctx.cwd, undefined);
			})
			.finally(() => {
				gitRefresh = undefined;
			});
		return gitRefresh;
	}

	async function refreshDailyCost(): Promise<void> {
		if (dailyRefresh) return dailyRefresh;
		dailyRefresh = scanDailyCost()
			.then((cost) => {
				dailyCost = cost;
			})
			.catch(() => {})
			.finally(() => {
				dailyRefresh = undefined;
			});
		return dailyRefresh;
	}

	function refresh(ctx: ExtensionContext): void {
		void Promise.all([refreshGit(ctx), refreshDailyCost()]).then(render);
	}

	function setEnabled(ctx: ExtensionContext, next: boolean): void {
		enabled = next;
		if (enabled) {
			installFooter(ctx);
			refresh(ctx);
			return;
		}
		ctx.ui.setFooter(undefined);
		footerInstalled = false;
	}

	unsubscribeFooterItems = onTauEvent(pi, "tau:footer-item", (item) => {
		if (!item.id.trim()) return;
		const text = item.text?.trim();
		const existing = items.get(item.id);
		if (!text) {
			if (!existing) return;
			items.delete(item.id);
			render();
			return;
		}

		const next = { id: item.id, priority: item.priority ?? 0, text };
		if (existing?.priority === next.priority && existing.text === next.text) return;
		items.set(item.id, next);
		render();
	});

	pi.registerCommand(COMMAND, {
		description: "Toggle Tau footer",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			setActiveCtx(ctx);

			const arg = args.trim().toLowerCase();
			if (!arg) {
				setEnabled(ctx, !enabled);
				ctx.ui.notify(enabled ? "Footer enabled" : "Footer disabled", "info");
				return;
			}

			if (arg === "on" || arg === "off") {
				setEnabled(ctx, arg === "on");
				ctx.ui.notify(enabled ? "Footer enabled" : "Footer disabled", "info");
				return;
			}

			if (arg === "refresh") {
				refresh(ctx);
				ctx.ui.notify("Footer refresh started", "info");
				return;
			}

			ctx.ui.notify(USAGE, "error");
		},
	});

	pi.on("session_start", (_event, ctx) => onStateChange(ctx));
	pi.on("session_tree", (_event, ctx) => onStateChange(ctx));
	pi.on("model_select", (_event, ctx) => onStateChange(ctx));
	pi.on("thinking_level_select", (_event, ctx) => onStateChange(ctx));
	pi.on("agent_start", (_event, ctx) => onStateChange(ctx));
	pi.on("turn_end", (_event, ctx) => onStateChange(ctx));
	pi.on("agent_end", (_event, ctx) => onStateChange(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeFooterItems?.();
		unsubscribeFooterItems = undefined;
		requestRender = undefined;
		activeCtx = undefined;
		footerInstalled = false;
		ctx.ui.setFooter(undefined);
	});

	function onStateChange(ctx: ExtensionContext): void {
		setActiveCtx(ctx);
		refresh(ctx);
	}
}

function parseGitStatus(stdout: string): GitSummary | undefined {
	let branch = "";
	let staged = 0;
	let modified = 0;
	let untracked = 0;
	let conflicts = 0;

	for (const line of stdout.split("\n")) {
		if (!line) continue;
		if (line.startsWith("## ")) {
			branch = line.slice(3).split("...")[0]?.trim() ?? "";
			continue;
		}

		const x = line[0];
		const y = line[1];
		if (x === "?" && y === "?") {
			untracked += 1;
			continue;
		}
		if (isConflict(x, y)) {
			conflicts += 1;
			continue;
		}
		if (x && x !== " ") staged += 1;
		if (y && y !== " ") modified += 1;
	}

	if (!branch) return undefined;
	const parts = [
		staged ? `+${staged}` : "",
		modified ? `~${modified}` : "",
		untracked ? `?${untracked}` : "",
		conflicts ? `!${conflicts}` : "",
	].filter(Boolean);
	return { branch, text: parts.length ? parts.join(" ") : "clean" };
}

function gitText(git: GitSummary | undefined): string {
	if (!git) return "";
	return git.text === "clean" ? git.branch : `${git.branch} (${git.text})`;
}

function isConflict(x: string | undefined, y: string | undefined): boolean {
	return x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
}

function sessionCost(ctx: ExtensionContext): UsageSummary {
	let usage = zeroUsage();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		usage = addUsage(usage, normalizeUsage((entry.message as AssistantMessage).usage));
	}
	return usage;
}

function statsText(theme: Theme, ctx: ExtensionContext, usage: UsageSummary, session: string, daily: string): string {
	const tokens: string[] = [];
	if (usage.input) tokens.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) tokens.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) tokens.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) tokens.push(`W${formatTokens(usage.cacheWrite)}`);
	if ((usage.cacheRead || usage.cacheWrite) && usage.latestCacheHitRate !== undefined)
		tokens.push(`CH${usage.latestCacheHitRate.toFixed(1)}%`);
	return [contextText(theme, ctx), theme.fg("dim", tokens.join(" ")), theme.fg("dim", `S|${session} D|${daily}`)]
		.filter(Boolean)
		.join(theme.fg("dim", " • "));
}

function contextText(theme: Theme, ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const percentValue = typeof usage?.percent === "number" ? usage.percent : undefined;
	const percent = percentValue === undefined ? "?" : `${percentValue.toFixed(1)}%`;
	return `${theme.fg(contextPercentColor(percentValue), percent)}${theme.fg("dim", `/${formatTokens(contextWindow)}`)}`;
}

function contextPercentColor(percent: number | undefined): ThemeColor {
	if (percent === undefined) return "dim";
	if (percent > 80) return "error";
	if (percent > 50) return "warning";
	return "dim";
}

function formatTokens(count: number): string {
	if (count < 1000) return `${Math.round(count)}`;
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

async function scanDailyCost(): Promise<number> {
	const range = localDayRange(Date.now());
	const seen = new Set<string>();
	let total = 0;

	for (const path of await sessionFiles()) {
		try {
			if ((await stat(path)).mtimeMs < range.startMs) continue;
			const raw = await readFile(path, "utf8");
			for (const line of raw.split("\n")) {
				const entry = parseRecord(line);
				if (!entry || entry.type !== "message") continue;
				const message = asRecord(entry.message);
				if (message?.role !== "assistant") continue;
				const timestamp = timestampMs(message.timestamp, entry.timestamp);
				if (timestamp < range.startMs || timestamp >= range.endMs) continue;
				const usage = normalizeUsage(message.usage);
				const key = [
					message.provider,
					message.model,
					timestamp,
					usage.input,
					usage.output,
					usage.cacheRead,
					usage.cacheWrite,
					usage.cost,
				].join(":");
				if (seen.has(key)) continue;
				seen.add(key);
				total += usage.cost;
			}
		} catch {
			// One bad session file should not break the footer.
		}
	}

	return total;
}

async function sessionFiles(): Promise<string[]> {
	const root = join(homedir(), ".pi", "agent", "sessions");
	const files: string[] = [];
	try {
		for (const dir of await readdir(root, { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			const child = join(root, dir.name);
			for (const file of await readdir(child, { withFileTypes: true })) {
				if (file.isFile() && file.name.endsWith(".jsonl")) files.push(join(child, file.name));
			}
		}
	} catch {
		return [];
	}
	return files;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		return asRecord(JSON.parse(trimmed));
	} catch {
		return undefined;
	}
}

function normalizeUsage(value: unknown): UsageSummary {
	const record = asRecord(value);
	const cost = asRecord(record?.cost);
	const input = numberOrZero(record?.input);
	const output = numberOrZero(record?.output);
	const cacheRead = numberOrZero(record?.cacheRead);
	const cacheWrite = numberOrZero(record?.cacheWrite);
	const promptTokens = input + cacheRead + cacheWrite;
	const costTotal =
		numberOrZero(cost?.total) ||
		numberOrZero(cost?.input) +
			numberOrZero(cost?.output) +
			numberOrZero(cost?.cacheRead) +
			numberOrZero(cost?.cacheWrite);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		latestCacheHitRate: promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined,
		cost: costTotal,
	};
}

function addUsage(left: UsageSummary, right: UsageSummary): UsageSummary {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		latestCacheHitRate: right.latestCacheHitRate ?? left.latestCacheHitRate,
		cost: left.cost + right.cost,
	};
}

function zeroUsage(): UsageSummary {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, latestCacheHitRate: undefined, cost: 0 };
}

function timestampMs(messageTimestamp: unknown, entryTimestamp: unknown): number {
	if (typeof messageTimestamp === "number") return messageTimestamp;
	if (typeof entryTimestamp === "string") return Date.parse(entryTimestamp);
	return Number.NaN;
}

function localDayRange(nowMs: number): { endMs: number; startMs: number } {
	const start = new Date(nowMs);
	start.setHours(0, 0, 0, 0);
	const end = new Date(start);
	end.setDate(end.getDate() + 1);
	return { startMs: start.getTime(), endMs: end.getTime() };
}

function footerItemsText(items: ReadonlyMap<string, FooterItem>): string {
	return [...items.values()]
		.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
		.map((item) => item.text)
		.join(" • ");
}

function extensionStatusesText(statuses: ReadonlyMap<string, string>): string {
	return [...statuses]
		.filter(([key, text]) => key !== "tau-posture" && text.trim())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, text]) => text.trim())
		.join(" • ");
}

function renderSplit(width: number, left: string, right: string): string {
	if (width <= 0) return "";
	const rightWidth = visibleWidth(right);
	if (!right) return truncateToWidth(left, width);
	if (!left) return truncateToWidth(right, width);
	const leftWidth = Math.max(0, width - rightWidth - 1);
	if (leftWidth <= 0) return truncateToWidth(right, width);
	const clippedLeft = truncateToWidth(left, leftWidth);
	const pad = " ".repeat(Math.max(1, width - visibleWidth(clippedLeft) - rightWidth));
	return truncateToWidth(`${clippedLeft}${pad}${right}`, width);
}

function shortenPath(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) return `~/${relative(home, cwd)}`;
	return cwd;
}

function sessionName(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "session_info") continue;
		const name = entry.name?.trim();
		if (name) return name;
	}
	return "";
}

function formatCost(value: number): string {
	return `$${value.toFixed(2)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
