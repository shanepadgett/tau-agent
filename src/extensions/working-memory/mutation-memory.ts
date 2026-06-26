import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauAgentEvents } from "../../shared/events.ts";
import {
	buildPathUpdateMessage,
	buildRereadMessage,
	PATH_UPDATE_CUSTOM_TYPE,
	type PathUpdateChange,
	REREAD_CUSTOM_TYPE,
} from "./memory-messages.ts";
import { evaluateRereadEligibility } from "./repo-scope.ts";
import type { WorkingMemorySettings } from "./settings.ts";

type MutationEvent = TauAgentEvents["tau:file-mutation.applied"];
type ContextSnapshotEvent = TauAgentEvents["tau:context.snapshot"];

interface PendingReread {
	path: string;
	absolutePath: string;
	sourceToolCallId: string;
}

interface PendingPathUpdate {
	sourceToolCallId: string;
	change: PathUpdateChange;
}

export function createMutationMemory(options: { getSettings: () => WorkingMemorySettings }): MutationMemory {
	return new MutationMemory(options);
}

class MutationMemory {
	private readonly options: { getSettings: () => WorkingMemorySettings };

	constructor(options: { getSettings: () => WorkingMemorySettings }) {
		this.options = options;
	}

	async sendMutationEvidence(pi: ExtensionAPI, event: MutationEvent): Promise<void> {
		if (event.source !== "patch" || event.status !== "completed") return;
		const rereads = new Map<string, PendingReread>();
		const pathUpdates: PendingPathUpdate[] = [];

		for (const change of event.changes) {
			const targetPath = change.move?.to ?? change.path;
			if (change.kind === "delete") {
				rereads.delete(change.path);
				pathUpdates.push({
					sourceToolCallId: event.toolCallId,
					change: { kind: "deleted", path: change.path },
				});
				continue;
			}
			if (change.move) {
				rereads.delete(change.move.from);
				pathUpdates.push({
					sourceToolCallId: event.toolCallId,
					change: { kind: "moved", from: change.move.from, to: change.move.to },
				});
			}
			if (change.kind === "add") {
				pathUpdates.push({
					sourceToolCallId: event.toolCallId,
					change: { kind: "created", path: targetPath },
				});
			}
			if (change.linesAdded === 0 && change.linesRemoved === 0 && change.move) continue;
			const eligibility = await evaluateRereadEligibility(event.cwd, targetPath, this.options.getSettings());
			if (eligibility.ok) {
				rereads.set(eligibility.relativePath, {
					path: eligibility.relativePath,
					absolutePath: eligibility.absolutePath,
					sourceToolCallId: event.toolCallId,
				});
			} else {
				rereads.delete(eligibility.relativePath);
				pathUpdates.push({
					sourceToolCallId: event.toolCallId,
					change: { kind: "changed", path: eligibility.relativePath, rereadSkipped: eligibility.reason },
				});
			}
		}

		await this.sendPathUpdates(pi, dedupePathUpdates(pathUpdates));
		await this.sendRereads(
			pi,
			[...rereads.values()].sort((left, right) => left.path.localeCompare(right.path)),
		);
	}

	async sendContextRereads(pi: ExtensionAPI, event: ContextSnapshotEvent): Promise<void> {
		for (const file of event.files) {
			const message = buildRereadMessage({ path: file.path, content: file.content, source: "tau-edit" });
			await pi.sendMessage(
				{ customType: REREAD_CUSTOM_TYPE, content: message.content, display: true, details: message.details },
				{ ...(event.deliverAs ? { deliverAs: event.deliverAs } : {}) },
			);
		}
	}

	private async sendPathUpdates(pi: ExtensionAPI, updates: PendingPathUpdate[]): Promise<void> {
		for (const update of groupPathUpdates(updates)) {
			const message = buildPathUpdateMessage(update.sourceToolCallId, update.changes);
			await pi.sendMessage({
				customType: PATH_UPDATE_CUSTOM_TYPE,
				content: message.content,
				display: true,
				details: message.details,
			});
		}
	}

	private async sendRereads(pi: ExtensionAPI, rereads: PendingReread[]): Promise<void> {
		for (const reread of rereads) {
			const content = await readFile(reread.absolutePath, "utf8").catch(() => undefined);
			if (content === undefined) continue;
			const message = buildRereadMessage({
				path: reread.path,
				content,
				source: "mutation",
				sourceToolCallId: reread.sourceToolCallId,
			});
			await pi.sendMessage({
				customType: REREAD_CUSTOM_TYPE,
				content: message.content,
				display: true,
				details: message.details,
			});
		}
	}
}

function dedupePathUpdates(updates: PendingPathUpdate[]): PendingPathUpdate[] {
	const seen = new Set<string>();
	const result: PendingPathUpdate[] = [];
	for (let index = updates.length - 1; index >= 0; index -= 1) {
		const update = updates[index];
		if (!update) continue;
		const key = `${update.sourceToolCallId}\u0000${JSON.stringify(update.change)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(update);
	}
	return result.reverse();
}

function groupPathUpdates(
	updates: PendingPathUpdate[],
): Array<{ sourceToolCallId: string; changes: PathUpdateChange[] }> {
	const groups: Array<{ sourceToolCallId: string; changes: PathUpdateChange[] }> = [];
	for (const update of updates) {
		const last = groups[groups.length - 1];
		if (last?.sourceToolCallId === update.sourceToolCallId) {
			last.changes.push(update.change);
		} else {
			groups.push({ sourceToolCallId: update.sourceToolCallId, changes: [update.change] });
		}
	}
	return groups;
}
