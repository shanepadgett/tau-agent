import {
	defineTool,
	keyText,
	type ExtensionAPI,
	type SessionEntry,
	type SessionMessageEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { prepareFileInjection } from "@shanepadgett/tau-agent";
import { areContinuityRowsVisible } from "../../shared/continuity-visibility.ts";
import type { FileInjectionFile } from "../../src/file-injection/index.ts";
import { extractConversationText } from "./messages.ts";

export const CHECKPOINT_TOOL = "checkpoint";
const CONTINUATION_TYPE = "tau.continuity";
const CONTINUATION_MESSAGE =
	"Continue directly from the checkpoint state and provided files. Do not acknowledge the checkpoint or describe this context transition. Continuity message metadata is internal; never repeat or mention its IDs. Trust the provided sources and continue the listed work.";
const CHECKPOINT_PREVIEW_CHARACTERS = 240;
const CHECKPOINT_RENDER_CHARACTERS = 24_000;
const CHECKPOINT_RENDER_LINES = 200;
const CONVERSATION_MESSAGE_ID_ATTRIBUTE = /^(<(?:user|assistant)-message)\s+id="(?:\\.|[^"\\])*">$/gm;

const lineRange = Type.Object(
	{
		startLine: Type.Integer({ minimum: 1 }),
		endLine: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const checkpointFile = Type.Union([
	Type.Object(
		{
			path: Type.String({ minLength: 1 }),
			mode: Type.Literal("read"),
			ranges: Type.Optional(Type.Array(lineRange)),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			path: Type.String({ minLength: 1 }),
			mode: Type.Literal("outline"),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			path: Type.String({ minLength: 1 }),
			mode: Type.Literal("deferred"),
			when: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);

const checkpointParams = Type.Object(
	{
		keepMessages: Type.Array(Type.String({ minLength: 1 }), {
			description:
				"Exact message-entry IDs from hidden continuity metadata or earlier checkpoint conversation entries.",
		}),
		work: Type.Array(Type.String(), { description: "Ordered current work, with the next thing first." }),
		facts: Type.Array(Type.String(), { description: "Concrete findings that must survive context replacement." }),
		decisions: Type.Array(Type.String(), { description: "Choices that continue to govern the work." }),
		files: Type.Array(checkpointFile, {
			description: "Current file reads, outlines, or deferred paths. Active files are injected separately.",
		}),
	},
	{ additionalProperties: false },
);

type CheckpointInput = Static<typeof checkpointParams>;

interface CheckpointToolDetails {
	v: 1;
	kind: "continuity.checkpoint";
	checkpointId: string;
	fileBatchId: string;
}

export function registerCheckpointTool(pi: ExtensionAPI): void {
	pi.registerTool(createCheckpointTool(pi));
}

function createCheckpointTool(pi: Pick<ExtensionAPI, "events" | "sendMessage">) {
	return defineTool<typeof checkpointParams, CheckpointToolDetails>({
		name: CHECKPOINT_TOOL,
		label: "checkpoint",
		promptSnippet:
			"checkpoint({ keepMessages, work, facts, decisions, files }) — replace disposable history with working context",
		description:
			"Replace disposable conversation and tool history with a rolling working checkpoint. Keep user and assistant messages by exact message-entry ID, not by copying their text. The latest user message is always retained. Assistant tool calls and thinking are never retained inside the conversation section.",
		promptGuidelines: [
			"Use exact IDs from hidden continuity message metadata or an earlier checkpoint; do not invent IDs or rewrite message text.",
			"Continuity message metadata is internal control data. Never repeat or mention its IDs in a response.",
			"Record concrete findings in facts and governing choices in decisions before checkpointing.",
			"Use read or outline for files needed now; use deferred with a condition for files that can wait.",
		],
		parameters: checkpointParams,
		renderShell: "self",
		renderCall(_args, theme, context) {
			return new ContinuityCheckpointComponent(theme, "checkpoint", context.expanded, true);
		},
		renderResult(result, options, theme) {
			const text = result.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			return new ContinuityCheckpointComponent(theme, text, options.expanded, false);
		},
		executionMode: "sequential",
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const selected = resolveSelectedMessages(params.keepMessages, ctx.sessionManager.getBranch());
			const text = formatCheckpointText(selected, params);
			const fileBatchId = `checkpoint:${toolCallId}`;
			const fileRequest = buildFileInjectionRequest(ctx.cwd, fileBatchId, params.files, signal);
			const prepared = fileRequest.files.length === 0 ? [] : await prepareFileInjection(pi, fileRequest);
			const failed = prepared.find((message) => message.details.status === "failed");
			if (failed) {
				throw new Error(
					`Checkpoint file injection failed for ${failed.details.path}: ${failed.details.error ?? "unknown error"}`,
				);
			}
			const display = areContinuityRowsVisible();
			for (const message of prepared) pi.sendMessage({ ...message, display });
			pi.sendMessage({
				customType: CONTINUATION_TYPE,
				content: CONTINUATION_MESSAGE,
				display: false,
				details: {
					v: 1,
					kind: "continuity.continuation",
					source: "continuity",
					batchId: fileBatchId,
				},
			});
			return {
				content: [{ type: "text", text }],
				details: { v: 1, kind: "continuity.checkpoint", checkpointId: toolCallId, fileBatchId },
			};
		},
	});
}

class ContinuityCheckpointComponent implements Component {
	private readonly theme: Theme;
	private readonly content: string;
	private readonly expanded: boolean;
	private readonly call: boolean;

	constructor(theme: Theme, content: string, expanded: boolean, call: boolean) {
		this.theme = theme;
		this.content = content;
		this.expanded = expanded;
		this.call = call;
	}

	render(width: number): string[] {
		if (!areContinuityRowsVisible()) return [];
		if (this.call) return [truncateToWidth(this.theme.fg("toolTitle", this.theme.bold(CHECKPOINT_TOOL)), width, "…")];
		const displayContent = this.content.replace(CONVERSATION_MESSAGE_ID_ATTRIBUTE, "$1>");
		if (!this.expanded) {
			const preview = displayContent.replace(/\s+/g, " ").trim().slice(0, CHECKPOINT_PREVIEW_CHARACTERS);
			const suffix = displayContent.length > CHECKPOINT_PREVIEW_CHARACTERS ? "…" : "";
			return [
				truncateToWidth(
					`${this.theme.fg("dim", preview + suffix)} ${this.theme.fg("muted", `(${keyText("app.tools.expand")} to expand)`)}`,
					width,
					"…",
				),
			];
		}

		const bounded =
			displayContent.length > CHECKPOINT_RENDER_CHARACTERS
				? `${displayContent.slice(0, CHECKPOINT_RENDER_CHARACTERS)}\n…`
				: displayContent;
		return wrapTextWithAnsi(this.theme.fg("dim", bounded), Math.max(1, width))
			.slice(0, CHECKPOINT_RENDER_LINES)
			.map((line) => truncateToWidth(line, width, "…"));
	}

	invalidate(): void {}
}

function resolveSelectedMessages(ids: readonly string[], branch: readonly SessionEntry[]): SessionMessageEntry[] {
	const entriesById = new Map(branch.map((entry) => [entry.id, entry]));
	const selectedIds = new Set(ids);
	const latestUser = [...branch].reverse().find(isUserMessageEntry);
	if (!latestUser) throw new Error("Checkpoint requires a current user message");
	selectedIds.add(latestUser.id);

	for (const id of selectedIds) {
		const entry = entriesById.get(id);
		if (!entry || !isConversationEntry(entry)) throw new Error(`Unknown user or assistant message ID: ${id}`);
		if (entry.message.role === "assistant" && extractConversationText(entry.message) === "") {
			throw new Error(`Assistant message ID has no text content: ${id}`);
		}
	}

	return branch.filter(
		(entry): entry is SessionMessageEntry => selectedIds.has(entry.id) && isConversationEntry(entry),
	);
}

function formatCheckpointText(selected: readonly SessionMessageEntry[], params: CheckpointInput): string {
	const conversation = selected
		.map((entry) => {
			const text = extractConversationText(entry.message);
			if (text === undefined) throw new Error(`Message ID is not a user or assistant message: ${entry.id}`);
			const role = entry.message.role === "user" ? "user" : "assistant";
			return `<${role}-message id=${JSON.stringify(entry.id)}>\n${text}\n</${role}-message>`;
		})
		.join("\n\n");
	const deferred = params.files
		.filter(
			(file): file is Extract<CheckpointInput["files"][number], { mode: "deferred" }> => file.mode === "deferred",
		)
		.map((file) => `- ${file.path} — ${file.when}`);

	return [
		`Conversation:\n${conversation || "(none)"}`,
		`Work:\n${formatList(params.work)}`,
		`Facts:\n${formatList(params.facts)}`,
		`Decisions:\n${formatList(params.decisions)}`,
		`Deferred files:\n${deferred.length ? deferred.join("\n") : "(none)"}`,
	].join("\n\n");
}

function buildFileInjectionRequest(
	cwd: string,
	batchId: string,
	files: CheckpointInput["files"],
	signal: AbortSignal | undefined,
) {
	const activeFiles: FileInjectionFile[] = [];
	for (const file of files) {
		if (file.mode === "deferred") continue;
		if (file.mode === "outline") {
			activeFiles.push({ path: file.path, mode: "outline" });
			continue;
		}
		activeFiles.push({
			path: file.path,
			mode: "full",
			...(file.ranges === undefined ? {} : { ranges: file.ranges }),
		});
	}
	return { cwd, source: "continuity", batchId, files: activeFiles, signal };
}

function formatList(items: readonly string[]): string {
	return items.length ? items.map((item) => `- ${item}`).join("\n") : "(none)";
}

function isConversationEntry(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant");
}

function isUserMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message" && entry.message.role === "user";
}
