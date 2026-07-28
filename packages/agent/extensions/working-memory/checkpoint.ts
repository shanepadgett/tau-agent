import { resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { truncateBoundedHead } from "../../shared/bounded-text-result.ts";
import { requestOutlineInjections, type PreparedOutlineInjection } from "../../shared/outline-injection.ts";
import { buildMemoryCatalog, collectPrunedRowIds } from "./memory.ts";
import { WORKING_MEMORY_TOOL, type DeferredFile, type WorkingMemoryCheckpointDetailsV1 } from "./state.ts";

const PATH = Type.String({ minLength: 1, maxLength: 500, pattern: "\\S" });

export const workingMemoryParameters = Type.Object(
	{
		continuation: Type.String({ minLength: 1, maxLength: 8_000, pattern: "\\S" }),
		keep: Type.Array(Type.String({ minLength: 3, maxLength: 100 }), { maxItems: 100 }),
		outlineFiles: Type.Array(PATH, { maxItems: 12 }),
		deferFiles: Type.Array(
			Type.Object(
				{
					path: PATH,
					reason: Type.String({ minLength: 1, maxLength: 300, pattern: "\\S" }),
					relevantWhen: Type.String({ minLength: 1, maxLength: 300, pattern: "\\S" }),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 8 },
		),
	},
	{ additionalProperties: false },
);

export type WorkingMemoryInput = Static<typeof workingMemoryParameters>;

interface ExecuteWorkingMemoryOptions {
	pi: Pick<ExtensionAPI, "events">;
	toolCallId: string;
	params: WorkingMemoryInput;
	signal: AbortSignal | undefined;
	ctx: ExtensionContext;
	generation: number;
	currentGeneration(): number;
}

export interface WorkingMemoryExecution {
	result: {
		content: Array<{ type: "text"; text: string }>;
		details: WorkingMemoryCheckpointDetailsV1;
	};
	outlines: PreparedOutlineInjection[];
}

export async function executeWorkingMemory(options: ExecuteWorkingMemoryOptions): Promise<WorkingMemoryExecution> {
	assertCurrent(options);
	const branch = options.ctx.sessionManager.getBranch();
	const catalog = buildMemoryCatalog(branch);
	const requestedRefs = [...new Set(options.params.keep)];
	const retained = requestedRefs
		.flatMap((ref) => {
			const unit = catalog.get(ref);
			return unit ? [unit] : [];
		})
		.sort((left, right) => left.order - right.order);
	const retainedRefs = retained.map((unit) => unit.ref);
	const warnings = requestedRefs
		.filter((ref) => !catalog.has(ref))
		.map((ref) => `${ref}: memory reference is unavailable and was not retained`);

	const outlinePaths = dedupePaths(options.params.outlineFiles, options.ctx.cwd);
	const outlineResponse = await requestOutlineInjections(options.pi, {
		cwd: options.ctx.cwd,
		batchId: options.toolCallId,
		paths: outlinePaths,
		signal: options.signal,
		isLifecycleCurrent: () => options.generation === options.currentGeneration(),
	});
	warnings.push(...outlineResponse.warnings.map((warning) => boundedWarning(warning)));
	assertCurrent(options);

	const outlinedKeys = new Set(
		outlineResponse.messages.map((message) => resolve(options.ctx.cwd, message.details.path)),
	);
	const deferredFiles: DeferredFile[] = [];
	const deferredKeys = new Set<string>();
	for (const file of options.params.deferFiles) {
		const path = normalizePath(file.path);
		const key = resolve(options.ctx.cwd, path);
		if (outlinedKeys.has(key) || deferredKeys.has(key)) continue;
		deferredKeys.add(key);
		deferredFiles.push({ path, reason: file.reason.trim(), relevantWhen: file.relevantWhen.trim() });
	}

	const anchorIndex = findAnchorEntry(branch, options.toolCallId);
	const preAnchorUnits = [...catalog.values()].filter((unit) => unit.order < anchorIndex);
	const prunedRowIds = collectPrunedRowIds(branch, anchorIndex);
	const details: WorkingMemoryCheckpointDetailsV1 = {
		v: 1,
		anchorToolCallId: options.toolCallId,
		retainedRefs,
		retainedLabels: retained.map((unit) => ({ ref: unit.ref, label: unit.label, preview: unit.preview })),
		prunedRowIds,
		outlinedFiles: outlineResponse.messages.map((message) => ({
			path: message.details.path,
			rowId: message.details.rowId,
		})),
		deferredFiles,
		removedUnits: Math.max(0, preAnchorUnits.length - retained.length),
		warnings,
	};
	const markdown = formatResult(options.params.continuation.trim(), deferredFiles, warnings);
	return {
		result: { content: [{ type: "text", text: truncateBoundedHead(markdown).content }], details },
		outlines: outlineResponse.messages,
	};
}

function formatResult(continuation: string, deferred: readonly DeferredFile[], warnings: readonly string[]): string {
	const sections = [`## Continue\n\n${continuation}`];
	if (deferred.length > 0) {
		sections.push(
			`## Deferred files\n\n${deferred
				.map((file) => `- \`${escapeCode(file.path)}\` — ${file.reason} Reconsider when: ${file.relevantWhen}.`)
				.join("\n")}`,
		);
	}
	if (warnings.length > 0) sections.push(`## Warnings\n\n${warnings.map((warning) => `- ${warning}`).join("\n")}`);
	return sections.join("\n\n");
}

function dedupePaths(paths: readonly string[], cwd: string): string[] {
	const keys = new Set<string>();
	const result: string[] = [];
	for (const raw of paths) {
		const path = normalizePath(raw);
		const key = resolve(cwd, path);
		if (keys.has(key)) continue;
		keys.add(key);
		result.push(path);
	}
	return result;
}

function findAnchorEntry(branch: readonly SessionEntry[], toolCallId: string): number {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (
			entry?.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(block) => block.type === "toolCall" && block.id === toolCallId && block.name === WORKING_MEMORY_TOOL,
			)
		) {
			return index;
		}
	}
	return -1;
}

function normalizePath(path: string): string {
	return path.trim().replace(/^@/, "");
}

function escapeCode(path: string): string {
	return path.replaceAll("`", "\\`");
}

function boundedWarning(warning: string): string {
	return warning.length <= 500 ? warning : `${warning.slice(0, 499)}…`;
}

function assertCurrent(options: ExecuteWorkingMemoryOptions): void {
	options.signal?.throwIfAborted();
	if (options.generation !== options.currentGeneration()) {
		throw new Error("Working-memory checkpoint crossed a session lifecycle boundary");
	}
}
