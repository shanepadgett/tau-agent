import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { asObject } from "./settings/json.ts";

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	latestCacheHitRate: number | undefined;
	cost: number;
}

interface UsageWindow {
	startMs: number;
	endMs: number;
}

interface UsageCosts {
	total: number;
	openai: number;
	anthropic: number;
	unattributed: number;
}

export async function readUsageCosts(range: UsageWindow, signal: AbortSignal): Promise<UsageCosts> {
	const costs: UsageCosts = { total: 0, openai: 0, anthropic: 0, unattributed: 0 };
	const seen = new Set<string>();
	const root = join(getAgentDir(), "sessions");
	signal.throwIfAborted();
	const dirs = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
		signal.throwIfAborted();
		if (asObject(error)?.code === "ENOENT") return [];
		throw error;
	});
	for (const dir of dirs) {
		signal.throwIfAborted();
		if (!dir.isDirectory()) continue;
		const child = join(root, dir.name);
		try {
			for (const file of await readdir(child, { withFileTypes: true })) {
				signal.throwIfAborted();
				if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
				const path = join(child, file.name);
				try {
					if ((await stat(path)).mtimeMs < range.startMs) continue;
					const raw = await readFile(path, { encoding: "utf8", signal });
					accumulateUsage(raw, range, seen, costs, signal);
				} catch {
					signal.throwIfAborted();
					// One unreadable or incomplete session file must not stop accounting.
				}
			}
		} catch {
			signal.throwIfAborted();
			// Another session may remove its directory while the scan is running.
		}
	}
	signal.throwIfAborted();
	return costs;
}

function accumulateUsage(
	raw: string,
	range: UsageWindow,
	seen: Set<string>,
	costs: UsageCosts,
	signal: AbortSignal,
): void {
	for (const line of raw.split("\n")) {
		signal.throwIfAborted();
		let entry: Record<string, unknown> | undefined;
		try {
			entry = asObject(JSON.parse(line));
		} catch {
			continue;
		}
		if (!entry) continue;
		const parsed = usageIdentityFromEntry(entry);
		if (
			!parsed ||
			!Number.isFinite(parsed.timestamp) ||
			parsed.timestamp < range.startMs ||
			parsed.timestamp >= range.endMs
		)
			continue;
		const usage = normalizeUsage(parsed.usageValue);
		const key = [
			...parsed.identity,
			parsed.timestamp,
			usage.input,
			usage.output,
			usage.cacheRead,
			usage.cacheWrite,
			usage.cost,
		].join(":");
		if (seen.has(key)) continue;
		seen.add(key);
		costs.total += usage.cost;
		if (parsed.provider === "openai-codex") costs.openai += usage.cost;
		else if (parsed.provider === "anthropic") costs.anthropic += usage.cost;
		else costs.unattributed += usage.cost;
	}
}

function usageIdentityFromEntry(
	entry: Record<string, unknown>,
): { usageValue: unknown; timestamp: number; identity: unknown[]; provider: unknown } | undefined {
	if (entry.type === "custom" && entry.customType === "tau.decisions.usage") {
		const data = asObject(entry.data);
		return {
			usageValue: { cost: { total: numberOrZero(data?.cost) } },
			timestamp: timestampMs(undefined, entry.timestamp),
			identity: [entry.customType, entry.id, data?.model, data?.feature],
			provider: typeof data?.model === "string" ? data.model.split("/")[0] : undefined,
		};
	}
	if (entry.type === "message") {
		const message = asObject(entry.message);
		if (!message) return undefined;
		const timestamp = timestampMs(message.timestamp, entry.timestamp);
		if (message.role === "assistant" && asObject(message.usage)) {
			return {
				usageValue: message.usage,
				timestamp,
				identity: ["assistant", message.provider, message.model],
				provider: message.provider,
			};
		}
		if (message.role === "toolResult" && asObject(message.usage)) {
			return {
				usageValue: message.usage,
				timestamp,
				identity: ["toolResult", message.toolName, message.toolCallId],
				provider: undefined,
			};
		}
		return undefined;
	}
	if ((entry.type === "compaction" || entry.type === "branch_summary") && asObject(entry.usage)) {
		return {
			usageValue: entry.usage,
			timestamp: timestampMs(undefined, entry.timestamp),
			identity: [entry.type, entry.id],
			provider: undefined,
		};
	}
	return undefined;
}

export function normalizeUsage(value: unknown): UsageSummary {
	const record = asObject(value);
	const cost = asObject(record?.cost);
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

function timestampMs(messageTimestamp: unknown, entryTimestamp: unknown): number {
	if (typeof messageTimestamp === "number") return messageTimestamp;
	if (typeof entryTimestamp === "string") return Date.parse(entryTimestamp);
	return Number.NaN;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
