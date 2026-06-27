import { readFile, stat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauAgentEvents } from "../../shared/events.ts";
import {
	AUTO_READ_CUSTOM_TYPE,
	buildAutoReadMessage,
	buildPathUpdateMessage,
	PATH_UPDATE_CUSTOM_TYPE,
	type PathUpdateChange,
} from "./memory-messages.ts";
import { displayPath, gitIgnored, hasNoisePart, matchesExcluded, resolveSearchPath } from "./path-utils.ts";
import type { SearchSettings } from "./settings.ts";

const AUTO_READ_MAX_BYTES = 50 * 1024;

type MutationEvent = TauAgentEvents["tau:file-mutation.applied"];
type ContextSnapshotEvent = TauAgentEvents["tau:context.snapshot"];

export function createMutationMemory(options: { getSettings: () => SearchSettings }): MutationMemory {
	return new MutationMemory(options);
}

class MutationMemory {
	private readonly options: { getSettings: () => SearchSettings };

	constructor(options: { getSettings: () => SearchSettings }) {
		this.options = options;
	}

	async sendMutationEvidence(pi: ExtensionAPI, event: MutationEvent): Promise<void> {
		if (event.source !== "patch" || event.status !== "completed") return;
		const updates: PathUpdateChange[] = [];
		const autoReads = new Map<string, { absolutePath: string; path: string }>();
		for (const change of event.changes) {
			const target = change.move?.to ?? change.path;
			if (change.kind === "delete") {
				updates.push({ kind: "deleted", path: change.path });
				continue;
			}
			if (change.move) updates.push({ kind: "moved", from: change.move.from, to: change.move.to });
			if (change.kind === "add") updates.push({ kind: "created", path: target });
			if (change.linesAdded === 0 && change.linesRemoved === 0 && change.move) continue;
			const eligibility = await evaluateAutoReadEligibility(event.cwd, target, this.options.getSettings());
			if (eligibility.ok)
				autoReads.set(eligibility.path, { absolutePath: eligibility.absolutePath, path: eligibility.path });
			else updates.push({ kind: "changed", path: eligibility.path, autoReadSkipped: eligibility.reason });
		}
		if (updates.length > 0) {
			const message = buildPathUpdateMessage(event.toolCallId, dedupeUpdates(updates));
			pi.sendMessage({
				customType: PATH_UPDATE_CUSTOM_TYPE,
				content: message.content,
				display: true,
				details: message.details,
			});
		}
		for (const autoRead of [...autoReads.values()].sort((left, right) => left.path.localeCompare(right.path))) {
			const content = await readFile(autoRead.absolutePath, "utf8").catch(() => undefined);
			if (content === undefined) continue;
			const message = buildAutoReadMessage({
				path: autoRead.path,
				content,
				source: "mutation",
				sourceToolCallId: event.toolCallId,
			});
			pi.sendMessage({
				customType: AUTO_READ_CUSTOM_TYPE,
				content: message.content,
				display: true,
				details: message.details,
			});
		}
	}

	async sendContextAutoReads(pi: ExtensionAPI, event: ContextSnapshotEvent): Promise<void> {
		for (const file of event.files) {
			const message = buildAutoReadMessage({ path: file.path, content: file.content, source: "tau-edit" });
			pi.sendMessage(
				{ customType: AUTO_READ_CUSTOM_TYPE, content: message.content, display: true, details: message.details },
				{ ...(event.deliverAs ? { deliverAs: event.deliverAs } : {}) },
			);
		}
	}
}

export async function evaluateAutoReadEligibility(
	cwd: string,
	rawPath: string,
	settings: SearchSettings,
): Promise<{ ok: true; absolutePath: string; path: string } | { ok: false; path: string; reason: string }> {
	const absolutePath = resolveSearchPath(cwd, rawPath);
	if (!absolutePath) return { ok: false, path: rawPath, reason: "outside cwd" };
	const path = displayPath(cwd, absolutePath);
	if (path.startsWith("..")) return { ok: false, path, reason: "outside cwd" };
	if (hasNoisePart(path)) return { ok: false, path, reason: "noise" };
	if (matchesExcluded(path, settings.excludedPaths)) return { ok: false, path, reason: "excluded" };
	const fileStat = await stat(absolutePath).catch(() => undefined);
	if (!fileStat) return { ok: false, path, reason: "missing" };
	if (!fileStat.isFile()) return { ok: false, path, reason: "not file" };
	if ((await gitIgnored(cwd, [path])).has(path)) return { ok: false, path, reason: "ignored" };
	if (fileStat.size > AUTO_READ_MAX_BYTES) return { ok: false, path, reason: "too large" };
	return { ok: true, absolutePath, path };
}

function dedupeUpdates(updates: PathUpdateChange[]): PathUpdateChange[] {
	const seen = new Set<string>();
	return updates.filter((update) => {
		const key = JSON.stringify(update);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
