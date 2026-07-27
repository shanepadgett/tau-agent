import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_PROJECTION_TYPE,
	isContextProjectionMessage,
	isLegacyContextMessage,
} from "../../shared/context-messages.ts";
import { requestOutlineInjections } from "../../shared/outline-injection.ts";
import type { ContextEntry } from "./definitions.ts";

type ContextMessage = ContextEvent["messages"][number];

export { CONTEXT_PROJECTION_TYPE } from "../../shared/context-messages.ts";

export interface SelectedContext {
	entries: ContextEntry[];
	missingEntryIds: string[];
	read: string[];
	outline: string[];
	references: string[];
}

export function selectContextEntries(entries: readonly ContextEntry[], entryIds: readonly string[]): SelectedContext {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const selected = entryIds.flatMap((id) => {
		const entry = byId.get(id);
		return entry ? [entry] : [];
	});
	const read = new Set(selected.flatMap((entry) => entry.read));
	const outline = new Set(selected.flatMap((entry) => entry.outline).filter((path) => !read.has(path)));
	const references = new Set(
		selected.flatMap((entry) => entry.references).filter((path) => !read.has(path) && !outline.has(path)),
	);
	return {
		entries: selected,
		missingEntryIds: entryIds.filter((id) => !byId.has(id)),
		read: [...read].sort((left, right) => left.localeCompare(right)),
		outline: [...outline].sort((left, right) => left.localeCompare(right)),
		references: [...references].sort((left, right) => left.localeCompare(right)),
	};
}

export async function contextProjectionKey(
	root: string,
	selection: SelectedContext,
	signal: AbortSignal | undefined,
	isLifecycleCurrent: () => boolean,
): Promise<string> {
	const paths = [...selection.read, ...selection.outline];
	const files: Array<[string, string]> = [];
	for (const path of paths) {
		signal?.throwIfAborted();
		if (!isLifecycleCurrent()) throw new Error("Context projection crossed a session lifecycle boundary");
		try {
			const hash = createHash("sha256");
			for await (const chunk of createReadStream(resolve(root, path), { signal })) {
				if (!isLifecycleCurrent()) throw new Error("Context projection crossed a session lifecycle boundary");
				hash.update(chunk);
			}
			files.push([path, hash.digest("hex")]);
		} catch (error) {
			if (signal?.aborted || !isLifecycleCurrent()) throw error;
			files.push([path, "missing"]);
		}
	}
	return JSON.stringify({
		entries: selection.entries.map((entry) => [entry.id, entry.description]),
		missingEntryIds: selection.missingEntryIds,
		read: selection.read,
		outline: selection.outline,
		references: selection.references,
		files,
	});
}

export async function buildContextProjection(
	pi: Pick<ExtensionAPI, "events">,
	root: string,
	selection: SelectedContext,
	signal: AbortSignal | undefined,
	isLifecycleCurrent: () => boolean,
): Promise<string> {
	const warnings = selection.missingEntryIds.map((id) => `${id}: selected entry no longer exists`);
	const reads: Array<{ path: string; content: string }> = [];
	for (const path of selection.read) {
		signal?.throwIfAborted();
		if (!isLifecycleCurrent()) throw new Error("Context projection crossed a session lifecycle boundary");
		try {
			reads.push({ path, content: await readFile(resolve(root, path), "utf8") });
		} catch (error) {
			warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const outlined = await requestOutlineInjections(pi, {
		cwd: root,
		batchId: randomUUID(),
		paths: selection.outline,
		signal,
		isLifecycleCurrent,
	});
	warnings.push(...outlined.warnings);
	if (!isLifecycleCurrent()) throw new Error("Context projection crossed a session lifecycle boundary");
	return [
		"Active repository context (ephemeral; rebuilt from the current branch selection before each model call):",
		...selection.entries.map((entry) => `- ${entry.id}: ${entry.description}`),
		...(selection.missingEntryIds.length ? selection.missingEntryIds.map((id) => `- ${id}: unavailable`) : []),
		"",
		"Complete current file contents:",
		...(reads.length
			? reads.flatMap(({ path, content }) => [`<read path=${JSON.stringify(path)}>`, content, "</read>"])
			: ["(none)"]),
		"",
		"Current structural outlines:",
		...(outlined.messages.length
			? outlined.messages.flatMap((message) => ["<outline>", message.content, "</outline>"])
			: ["(none)"]),
		"",
		"Unloaded references:",
		...(selection.references.length ? selection.references.map((path) => `- ${path}`) : ["(none)"]),
		...(warnings.length ? ["", "Projection warnings:", ...warnings.map((warning) => `- ${warning}`)] : []),
		"",
		"Treat complete reads and outlines as current snapshots. Inspect unloaded references only when the request or concrete evidence requires them. Explore elsewhere only for missing information.",
	].join("\n");
}

export function contextProjectionMessage(content: string): ContextMessage {
	return {
		role: "custom",
		customType: CONTEXT_PROJECTION_TYPE,
		content,
		display: false,
		timestamp: Date.now(),
	};
}

export function removeLegacyContextMessages(messages: readonly ContextMessage[]): ContextMessage[] {
	return messages.filter((message) => !isContextProjectionMessage(message) && !isLegacyContextMessage(message));
}
