import { resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const SESSION_MEMORY_TOOL = "session_memory";
export const MAX_SNAPSHOT_BYTES = 16_000;

const NONEMPTY = { minLength: 1, pattern: "\\S" } as const;
const PATH = Type.String({ ...NONEMPTY, maxLength: 500 });
const MEMORY_ID = Type.String({
	minLength: 1,
	maxLength: 64,
	pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
});

const memoryItemSchema = Type.Object(
	{
		id: MEMORY_ID,
		text: Type.String({ ...NONEMPTY, maxLength: 1_000 }),
	},
	{ additionalProperties: false },
);

const deferredFileSchema = Type.Object(
	{
		path: PATH,
		reason: Type.String({ ...NONEMPTY, maxLength: 300 }),
		relevantWhen: Type.String({ ...NONEMPTY, maxLength: 300 }),
	},
	{ additionalProperties: false },
);

const updateSchema = Type.Object(
	{
		action: Type.Literal("update"),
		goal: Type.String({ ...NONEMPTY, maxLength: 2_000 }),
		objective: Type.String({ ...NONEMPTY, maxLength: 1_000 }),
		tasks: Type.Array(Type.String({ ...NONEMPTY, maxLength: 400 }), { maxItems: 8 }),
		carry: Type.Array(memoryItemSchema, { maxItems: 12 }),
		durable: Type.Array(memoryItemSchema, { maxItems: 24 }),
		readFiles: Type.Array(PATH, { maxItems: 12 }),
		outlineFiles: Type.Array(PATH, { maxItems: 12 }),
		deferFiles: Type.Array(deferredFileSchema, { maxItems: 8 }),
	},
	{ additionalProperties: false },
);

export const sessionMemoryParameters = Type.Union([
	updateSchema,
	Type.Object({ action: Type.Literal("checkpoint") }, { additionalProperties: false }),
]);

const carryMemorySchema = Type.Object(
	{
		id: MEMORY_ID,
		text: Type.String({ ...NONEMPTY, maxLength: 1_000 }),
		bornAtCheckpoint: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const stateSchema = Type.Object(
	{
		goal: Type.String({ ...NONEMPTY, maxLength: 2_000 }),
		objective: Type.String({ ...NONEMPTY, maxLength: 1_000 }),
		tasks: Type.Array(Type.String({ ...NONEMPTY, maxLength: 400 }), { maxItems: 8 }),
		carry: Type.Array(carryMemorySchema, { maxItems: 12 }),
		durable: Type.Array(memoryItemSchema, { maxItems: 24 }),
		readFiles: Type.Array(PATH, { maxItems: 12 }),
		outlineFiles: Type.Array(PATH, { maxItems: 12 }),
		deferFiles: Type.Array(deferredFileSchema, { maxItems: 8 }),
	},
	{ additionalProperties: false },
);

const detailsSchema = Type.Object(
	{
		v: Type.Literal(1),
		toolCallId: Type.String(NONEMPTY),
		kind: Type.Union([Type.Literal("update"), Type.Literal("checkpoint")]),
		checkpoint: Type.Integer({ minimum: 0 }),
		state: stateSchema,
		outlinedRows: Type.Array(
			Type.Object({ path: PATH, rowId: Type.String(NONEMPTY) }, { additionalProperties: false }),
		),
		prunedRowIds: Type.Array(Type.String(NONEMPTY)),
		warnings: Type.Array(Type.String({ ...NONEMPTY, maxLength: 500 }), { maxItems: 32 }),
	},
	{ additionalProperties: false },
);

export type SessionMemoryInput = Static<typeof sessionMemoryParameters>;
export type SessionMemoryUpdateInput = Static<typeof updateSchema>;
export type MemoryItem = Static<typeof memoryItemSchema>;
export type DeferredFile = Static<typeof deferredFileSchema>;
export type CarryMemory = Static<typeof carryMemorySchema>;
export type SessionMemoryState = Static<typeof stateSchema>;
export type SessionMemoryDetailsV1 = Static<typeof detailsSchema>;

export interface ReplayedSessionMemory {
	latest: SessionMemoryDetailsV1 | undefined;
	latestText: string | undefined;
	latestCheckpoint: SessionMemoryDetailsV1 | undefined;
	latestCheckpointText: string | undefined;
	recoveryText: string | undefined;
	latestCheckpointResultIndex: number;
	updateSinceCheckpoint: boolean;
	prunedRowIds: ReadonlySet<string>;
	updatedAt: number | undefined;
	hasPostCheckpointAssistant: boolean;
	successfulToolResultsSinceUpdate: number;
}

export function normalizeUpdate(
	input: SessionMemoryUpdateInput,
	previous: SessionMemoryState | undefined,
	checkpoint: number,
	cwd: string,
): SessionMemoryState {
	const memoryIds = new Set<string>();
	const memory = (items: readonly MemoryItem[]): MemoryItem[] =>
		items.map((item) => {
			if (memoryIds.has(item.id)) throw new Error(`Memory ID ${item.id} appears more than once`);
			memoryIds.add(item.id);
			return { id: item.id, text: item.text.trim() };
		});
	const previousCarry = new Map(previous?.carry.map((item) => [item.id, item]) ?? []);
	const carry = memory(input.carry).map((item) => ({
		...item,
		bornAtCheckpoint: previousCarry.get(item.id)?.bornAtCheckpoint ?? checkpoint,
	}));
	const durable = memory(input.durable);

	const rootInstructions = resolve(cwd, "AGENTS.md");
	const pathKeys = new Set<string>();
	const paths = (values: readonly string[]): string[] => {
		const result: string[] = [];
		for (const value of values) {
			const path = normalizePath(value);
			const key = resolve(cwd, path);
			if (key === rootInstructions || pathKeys.has(key)) continue;
			pathKeys.add(key);
			result.push(path);
		}
		return result;
	};
	const readFiles = paths(input.readFiles);
	const outlineFiles = paths(input.outlineFiles);
	const deferFiles: DeferredFile[] = [];
	for (const item of input.deferFiles) {
		const path = normalizePath(item.path);
		const key = resolve(cwd, path);
		if (key === rootInstructions || pathKeys.has(key)) continue;
		pathKeys.add(key);
		deferFiles.push({ path, reason: item.reason.trim(), relevantWhen: item.relevantWhen.trim() });
	}

	return {
		goal: input.goal.trim(),
		objective: input.objective.trim(),
		tasks: input.tasks.map((task) => task.trim()),
		carry,
		durable,
		readFiles,
		outlineFiles,
		deferFiles,
	};
}

export function checkpointState(
	state: SessionMemoryState,
	currentCheckpoint: number,
): { state: SessionMemoryState; warnings: string[] } {
	const durableIds = new Set(state.durable.map((item) => item.id));
	const expired = state.carry.filter((item) => item.bornAtCheckpoint < currentCheckpoint && !durableIds.has(item.id));
	return {
		state: {
			...state,
			carry: state.carry.filter((item) => item.bornAtCheckpoint >= currentCheckpoint && !durableIds.has(item.id)),
		},
		warnings: expired.map((item) => `${item.id}: carry memory expired`),
	};
}

export function formatSessionMemory(
	state: SessionMemoryState,
	checkpoint: number,
	warnings: readonly string[],
): string {
	const lines = [
		`Session memory · checkpoint ${checkpoint}`,
		"",
		"Goal",
		state.goal,
		"",
		"Objective",
		state.objective,
		"",
		`Tasks ${state.tasks.length}`,
		...state.tasks.map((task) => `- ${task}`),
		"",
		`Carry ${state.carry.length}`,
		...state.carry.map((item) => `- ${item.id}: ${item.text}`),
		"",
		`Durable ${state.durable.length}`,
		...state.durable.map((item) => `- ${item.id}: ${item.text}`),
		"",
		"Files",
		`Read ${state.readFiles.length}`,
		...state.readFiles.map((path) => `- ${path}`),
		`Outline ${state.outlineFiles.length}`,
		...state.outlineFiles.map((path) => `- ${path}`),
		`Deferred ${state.deferFiles.length}`,
		...state.deferFiles.map((file) => `- ${file.path} · ${file.reason} · when ${file.relevantWhen}`),
	];
	if (warnings.length > 0) {
		const warningHeader = ["", `Warnings ${warnings.length}`];
		if (Buffer.byteLength([...lines, ...warningHeader].join("\n"), "utf8") > MAX_SNAPSHOT_BYTES) {
			return lines.join("\n");
		}
		lines.push(...warningHeader);
		for (let index = 0; index < warnings.length; index += 1) {
			const warning = warnings[index];
			if (!warning) continue;
			const candidate = [...lines, `- ${warning}`].join("\n");
			if (Buffer.byteLength(candidate, "utf8") > MAX_SNAPSHOT_BYTES) {
				const omitted = warnings.length - index;
				const marker = `- ${omitted} more warning${omitted === 1 ? "" : "s"} omitted`;
				if (Buffer.byteLength([...lines, marker].join("\n"), "utf8") <= MAX_SNAPSHOT_BYTES) lines.push(marker);
				break;
			}
			lines.push(`- ${warning}`);
		}
	}
	return lines.join("\n");
}

export function assertSnapshotBound(state: SessionMemoryState, checkpoint: number): void {
	if (Buffer.byteLength(formatSessionMemory(state, checkpoint, []), "utf8") > MAX_SNAPSHOT_BYTES) {
		throw new Error("Session memory exceeds 16,000 UTF-8 bytes");
	}
}

export function parseSessionMemoryDetails(
	value: unknown,
	toolCallId: string,
	content: string,
	cwd = "/",
): SessionMemoryDetailsV1 | undefined {
	if (!Value.Check(detailsSchema, value)) return undefined;
	const details = value as SessionMemoryDetailsV1;
	if (details.toolCallId !== toolCallId) return undefined;
	if (details.state.carry.some((item) => item.bornAtCheckpoint > details.checkpoint)) return undefined;
	const ids = [...details.state.carry, ...details.state.durable].map((item) => item.id);
	if (new Set(ids).size !== ids.length) return undefined;
	if (!tiersSeparated(details.state, cwd)) return undefined;
	if (new Set(details.prunedRowIds).size !== details.prunedRowIds.length) return undefined;
	if (new Set(details.outlinedRows.map((item) => item.path)).size !== details.outlinedRows.length) return undefined;
	if (!details.outlinedRows.every((item) => details.state.outlineFiles.includes(item.path))) return undefined;
	if (formatSessionMemory(details.state, details.checkpoint, details.warnings) !== content) return undefined;
	if (Buffer.byteLength(content, "utf8") > MAX_SNAPSHOT_BYTES) return undefined;
	return details;
}

export function replaySessionMemory(branch: readonly SessionEntry[], cwd = "/"): ReplayedSessionMemory {
	let latest: SessionMemoryDetailsV1 | undefined;
	let latestText: string | undefined;
	let latestCheckpoint: SessionMemoryDetailsV1 | undefined;
	let latestCheckpointText: string | undefined;
	let recoveryText: string | undefined;
	let latestCheckpointResultIndex = -1;
	let latestCompactionIndex = -1;
	let updateSinceCheckpoint = false;
	let updatedAt: number | undefined;
	let successfulToolResultsSinceUpdate = 0;
	const prunedRowIds = new Set<string>();
	const updateToolCallIds = new Set<string>();
	for (let index = 0; index < branch.length; index += 1) {
		const entry = branch[index];
		if (entry?.type === "compaction") {
			recoveryText = latestText ?? latestCheckpointText;
			latestCompactionIndex = index;
			continue;
		}
		if (entry?.type !== "message") continue;
		if (entry.message.role === "assistant") {
			for (const item of entry.message.content) {
				if (
					item.type === "toolCall" &&
					item.name === SESSION_MEMORY_TOOL &&
					isRecord(item.arguments) &&
					item.arguments.action === "update"
				)
					updateToolCallIds.add(item.id);
			}
			continue;
		}
		if (entry.message.role !== "toolResult" || entry.message.isError) continue;
		if (entry.message.toolName !== SESSION_MEMORY_TOOL) {
			successfulToolResultsSinceUpdate += 1;
			continue;
		}
		const text = firstText(entry.message.content);
		const details = parseSessionMemoryDetails(entry.message.details, entry.message.toolCallId, text, cwd);
		if (!details) continue;
		if (details.kind === "update" || updateToolCallIds.has(entry.message.toolCallId)) {
			successfulToolResultsSinceUpdate = 0;
		}
		latest = details;
		latestText = text;
		updatedAt = Date.parse(entry.timestamp);
		for (const rowId of details.prunedRowIds) prunedRowIds.add(rowId);
		if (details.kind === "checkpoint") {
			latestCheckpoint = details;
			latestCheckpointText = text;
			latestCheckpointResultIndex = index;
			updateSinceCheckpoint = false;
		} else {
			updateSinceCheckpoint = true;
		}
	}
	const hasPostCheckpointAssistant =
		latestCheckpointResultIndex >= 0 &&
		branch
			.slice(latestCheckpointResultIndex + 1)
			.some((entry) => entry.type === "message" && entry.message.role === "assistant");
	return {
		latest,
		latestText,
		latestCheckpoint,
		latestCheckpointText,
		recoveryText:
			latestCheckpointResultIndex > latestCompactionIndex
				? latestCheckpointText
				: (recoveryText ?? latestCheckpointText),
		latestCheckpointResultIndex,
		updateSinceCheckpoint,
		prunedRowIds,
		updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined,
		hasPostCheckpointAssistant,
		successfulToolResultsSinceUpdate,
	};
}

function tiersSeparated(state: SessionMemoryState, cwd: string): boolean {
	const keys = [...state.readFiles, ...state.outlineFiles, ...state.deferFiles.map((item) => item.path)].map((path) =>
		resolve(cwd, path),
	);
	return new Set(keys).size === keys.length;
}

function normalizePath(path: string): string {
	return path.trim().replace(/^@/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstText(content: readonly { type: string; text?: string }[]): string {
	for (const item of content) if (item.type === "text" && typeof item.text === "string") return item.text;
	return "";
}
