import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readMetaFromMessage, type ReadCacheMode } from "./read-cache.ts";
import { createReadStatsPanel, type ReadSavingsSnapshot } from "./read-stats-panel.ts";

interface ContextTotals {
	baseline: number;
	returned: number;
	unchangedSaved: number;
	diffSaved: number;
}

export async function showReadStats(ctx: ExtensionCommandContext): Promise<void> {
	const entries = ctx.sessionManager.getEntries();
	const branchIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
	const current = calculateSnapshot(entries, branchIds, "Current chat");
	const whole = calculateSnapshot(entries, undefined, "Whole session");
	await ctx.ui.custom(
		(tui, theme, keybindings, done) => createReadStatsPanel(tui, theme, keybindings, done, current, whole),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "54%", minWidth: 50, maxHeight: "85%", margin: 2 },
		},
	);
}

function calculateSnapshot(
	entries: readonly unknown[],
	includedIds: ReadonlySet<string> | undefined,
	label: string,
): ReadSavingsSnapshot {
	const states = new Map<string, ContextTotals>();
	const counts: Record<ReadCacheMode, number> = { baseline: 0, recovery: 0, unchanged: 0, diff: 0 };
	let baselineTokens = 0;
	let returnedTokens = 0;
	let costSaved = 0;
	let unchangedCost = 0;
	let diffCost = 0;
	let readCount = 0;

	for (const entry of entries) {
		if (!isRecord(entry) || typeof entry.id !== "string") continue;
		const parent = typeof entry.parentId === "string" ? states.get(entry.parentId) : undefined;
		const state: ContextTotals = parent
			? { ...parent }
			: { baseline: 0, returned: 0, unchangedSaved: 0, diffSaved: 0 };
		if (entry.type === "compaction") {
			state.baseline = 0;
			state.returned = 0;
			state.unchangedSaved = 0;
			state.diffSaved = 0;
		}

		if (entry.type === "message" && "message" in entry) {
			const meta = readMetaFromMessage(entry.message);
			if (meta) {
				state.baseline += meta.baselineTokens;
				state.returned += meta.returnedTokens;
				const saved = Math.max(0, meta.baselineTokens - meta.returnedTokens);
				if (meta.mode === "unchanged") state.unchangedSaved += saved;
				if (meta.mode === "diff") state.diffSaved += saved;
				if (!includedIds || includedIds.has(entry.id)) {
					counts[meta.mode] += 1;
					readCount += 1;
				}
			}

			if ((!includedIds || includedIds.has(entry.id)) && isAssistantMessage(entry.message)) {
				baselineTokens += state.baseline;
				returnedTokens += state.returned;
				const inputTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				const inputCost =
					entry.message.usage.cost.input +
					entry.message.usage.cost.cacheRead +
					entry.message.usage.cost.cacheWrite;
				const costPerToken = inputTokens > 0 ? inputCost / inputTokens : 0;
				unchangedCost += state.unchangedSaved * costPerToken;
				diffCost += state.diffSaved * costPerToken;
				costSaved += (state.baseline - state.returned) * costPerToken;
			}
		}
		states.set(entry.id, state);
	}

	return {
		label,
		secondary: `${readCount} read${readCount === 1 ? "" : "s"} ${label === "Current chat" ? "in this chat" : "across everything done in this session"}`,
		baselineTokens,
		returnedTokens,
		costSaved,
		unchangedCost,
		diffCost,
		counts,
	};
}

function isAssistantMessage(value: unknown): value is {
	role: "assistant";
	usage: {
		input: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { input: number; cacheRead: number; cacheWrite: number };
	};
} {
	if (!isRecord(value) || value.role !== "assistant" || !isRecord(value.usage)) return false;
	if (!isRecord(value.usage.cost)) return false;
	return (
		typeof value.usage.input === "number" &&
		typeof value.usage.cacheRead === "number" &&
		typeof value.usage.cacheWrite === "number" &&
		typeof value.usage.cost.input === "number" &&
		typeof value.usage.cost.cacheRead === "number" &&
		typeof value.usage.cost.cacheWrite === "number"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
