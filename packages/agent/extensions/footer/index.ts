// lean: footer mixes git-status parse + usage/cost math + render; high churn
// (fallow hotspot). Do NOT proactive-split — wait for a change that forces a
// natural seam, then extract that concern only.
import { homedir } from "node:os";
import { relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { INFO_SEPARATOR } from "@shanepadgett/tau-tui";
import { emitTauEvent, onTauEventImmediately, type TauAgentEvents } from "../../shared/events.ts";
import { loadTauExtensionSettings, updateTauExtensionSettings } from "../../shared/settings/load.ts";
import { readUsageCosts } from "../../shared/usage.ts";
import footerSettings from "./settings.ts";
import { contextBar, statsParts } from "./stats.ts";

interface GitSummary {
	branch: string;
	text: string;
}

const COMMAND = "footer";
const USAGE = "Usage: /footer [on|off|refresh]";

export default function footerExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let activeCtx: ExtensionContext | undefined;
	let footerInstalled = false;
	let requestRender: (() => void) | undefined;
	const gitByCwd = new Map<string, GitSummary | undefined>();
	let gitRefresh: Promise<void> | undefined;
	let dailyCost: number | undefined;
	let dailyRefresh: Promise<void> | undefined;
	let classifier: string | null = null;
	let compactionLevel: TauAgentEvents["tau:compaction.level"] | null = null;
	onTauEventImmediately(pi, "footer.classifier", "tau:decisions.classifier", (label) => {
		classifier = label;
		render();
	});
	onTauEventImmediately(pi, "footer.compaction", "tau:compaction.level", (level) => {
		compactionLevel = level;
		render();
	});
	function publishContextBar(): void {
		const ctx = activeCtx;
		emitTauEvent(pi, "tau:editor-slot", {
			slot: "top-center",
			id: "context-bar",
			text: ctx && enabled ? contextBar(ctx.ui.theme, ctx, compactionLevel) : undefined,
		});
	}

	function render(): void {
		publishContextBar();
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
					requestRender?.();
				},
				render(width: number): string[] {
					if (!enabled) return [];
					const currentCtx = activeCtx ?? ctx;
					const git = gitByCwd.get(currentCtx.cwd);
					const stats = statsParts(theme, {
						ctx: currentCtx,
						thinking: pi.getThinkingLevel(),
						classifier,
						dailyCost,
					});
					const costs =
						visibleWidth(stats.left) + 2 + visibleWidth(stats.rightLong) <= width
							? stats.rightLong
							: stats.rightShort;
					const location = [shortenPath(currentCtx.cwd), gitText(git)].filter(Boolean).join(INFO_SEPARATOR);
					const trailing = [extensionStatusesText(footerData.getExtensionStatuses()), pi.getSessionName()?.trim()]
						.filter(Boolean)
						.join(INFO_SEPARATOR);

					return [
						renderSplit(width, stats.left, costs),
						renderSplit(width, theme.fg("dim", location), theme.fg("dim", trailing)),
					];
				},
			} satisfies Component & { dispose(): void; invalidate(): void };
		});
	}

	async function refreshGit(ctx: ExtensionContext): Promise<void> {
		if (gitRefresh) return gitRefresh;
		const cwd = ctx.cwd;
		gitRefresh = (async () => {
			const result = await pi.exec(
				"git",
				["--no-optional-locks", "status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
				{ cwd, timeout: 1_000 },
			);
			gitByCwd.set(cwd, result.code === 0 ? parseGitStatus(result.stdout) : undefined);
		})()
			.catch(() => {
				gitByCwd.set(cwd, undefined);
			})
			.finally(() => {
				gitRefresh = undefined;
			});
		return gitRefresh;
	}

	async function refreshDailyCost(): Promise<void> {
		if (dailyRefresh) return dailyRefresh;
		dailyRefresh = readUsageCosts(localDayRange(Date.now()), AbortSignal.timeout(10000))
			.then((costs) => {
				dailyCost = costs.total;
			})
			.catch(() => {})
			.finally(() => {
				dailyRefresh = undefined;
			});
		return dailyRefresh;
	}

	function refresh(ctx: ExtensionContext, includeDaily = true): void {
		const tasks = includeDaily ? [refreshGit(ctx), refreshDailyCost()] : [refreshGit(ctx)];
		void Promise.all(tasks).then(render);
	}

	function rerender(ctx: ExtensionContext): void {
		setActiveCtx(ctx);
		render();
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
		publishContextBar();
	}

	pi.registerCommand(COMMAND, {
		description: "Toggle Tau footer",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			setActiveCtx(ctx);

			const arg = args.trim().toLowerCase();
			if (!arg) {
				const next = !enabled;
				setEnabled(ctx, next);
				await saveEnabled(ctx, next);
				ctx.ui.notify(enabled ? "Footer enabled" : "Footer disabled", "info");
				return;
			}

			if (arg === "on" || arg === "off") {
				const next = arg === "on";
				setEnabled(ctx, next);
				await saveEnabled(ctx, next);
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

	pi.on("session_start", async (_event, ctx) => {
		const settings = await loadTauExtensionSettings(ctx, footerSettings);
		setEnabled(ctx, settings.enabled);
		onStateChange(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		onStateChange(ctx, false);
	});
	pi.on("model_select", (_event, ctx) => {
		rerender(ctx);
	});
	pi.on("thinking_level_select", (_event, ctx) => {
		rerender(ctx);
	});
	pi.on("agent_start", (_event, ctx) => onStateChange(ctx, false));
	pi.on("turn_end", (_event, ctx) => onStateChange(ctx));
	pi.on("agent_end", (_event, ctx) => onStateChange(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		requestRender = undefined;
		activeCtx = undefined;
		classifier = null;
		compactionLevel = null;
		footerInstalled = false;
		ctx.ui.setFooter(undefined);
		emitTauEvent(pi, "tau:editor-slot", { slot: "top-center", id: "context-bar" });
	});

	function onStateChange(ctx: ExtensionContext, includeDaily = true): void {
		setActiveCtx(ctx);
		refresh(ctx, includeDaily);
	}
}

async function saveEnabled(ctx: ExtensionContext, enabled: boolean): Promise<void> {
	await updateTauExtensionSettings("global", ctx, footerSettings, (current) => ({ ...current, enabled }));
}

function countGitLine(
	line: string,
	counts: { staged: number; modified: number; untracked: number; conflicts: number },
): void {
	const x = line[0];
	const y = line[1];
	if (x === "?" && y === "?") {
		counts.untracked += 1;
		return;
	}
	if (isConflict(x, y)) {
		counts.conflicts += 1;
		return;
	}
	if (x && x !== " ") counts.staged += 1;
	if (y && y !== " ") counts.modified += 1;
}

function formatGitCounts(counts: { staged: number; modified: number; untracked: number; conflicts: number }): string {
	const parts = [
		counts.staged ? `+${counts.staged}` : "",
		counts.modified ? `~${counts.modified}` : "",
		counts.untracked ? `?${counts.untracked}` : "",
		counts.conflicts ? `!${counts.conflicts}` : "",
	].filter(Boolean);
	return parts.length ? parts.join(" ") : "clean";
}

function parseGitStatus(stdout: string): GitSummary | undefined {
	let branch = "";
	const counts = { staged: 0, modified: 0, untracked: 0, conflicts: 0 };

	for (const line of stdout.split("\n")) {
		if (!line) continue;
		if (line.startsWith("## ")) {
			branch = line.slice(3).split("...")[0]?.trim() ?? "";
			continue;
		}
		countGitLine(line, counts);
	}

	if (!branch) return undefined;
	return { branch, text: formatGitCounts(counts) };
}

function gitText(git: GitSummary | undefined): string {
	if (!git) return "";
	return git.text === "clean" ? git.branch : `${git.branch} (${git.text})`;
}

function isConflict(x: string | undefined, y: string | undefined): boolean {
	return x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
}

function localDayRange(nowMs: number): { endMs: number; startMs: number } {
	const start = new Date(nowMs);
	start.setHours(0, 0, 0, 0);
	const end = new Date(start);
	end.setDate(end.getDate() + 1);
	return { startMs: start.getTime(), endMs: end.getTime() };
}

function extensionStatusesText(statuses: ReadonlyMap<string, string>): string {
	return [...statuses]
		.filter(([, text]) => text.trim())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, text]) => text.trim())
		.join(INFO_SEPARATOR);
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
