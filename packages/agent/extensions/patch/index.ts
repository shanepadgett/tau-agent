import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { emitTauEvent } from "../../shared/events.js";
import { createToolRowStateStore } from "../../shared/tool-row-state.js";
import { type ApplyPatchSummary, applyPatch } from "./executor.ts";
import { renderPatchCall, renderPatchResult } from "./render.ts";
import { formatPatchSummary } from "./summary.ts";

const SUPPRESSED_TOOLS = new Set(["edit", "write"]);

const patchParams = Type.Object({
	input: Type.String({
		description: [
			'Pass the full patch as this input string. Tool call arguments must be exactly { "input": "*** Begin Patch\\n...\\n*** End Patch" }; never put the patch text in a JSON object key.',
			"",
			"Apply one structured multi-file patch. Put the full patch text in this field.",
			"",
			"ENVELOPE",
			"*** Begin Patch",
			"[one or more file sections]",
			"*** End Patch",
			"",
			"Patch marker lines may have leading/trailing whitespace. File content starts after the patch prefix and keeps the remaining text exactly.",
			"Malformed envelopes fail the whole patch. Section parse, match, duplicate-path, missing-file, and move-target errors fail those sections while independent valid sections still apply.",
			"",
			"SECTIONS",
			"*** Add File: <path>        whole-file write; only + lines become content; may overwrite",
			"*** Replace File: <path>    whole-file write reported as replacement; only + lines become content",
			"*** Update File: <path>     contextual edit of an existing file",
			"*** Move to: <new-path>     optional, first line after Update File header, before any hunks; target must not exist",
			"*** Delete File: <path>     removes an existing file; must be the only line in its section",
			"",
			"UPDATE HUNKS",
			"@@ or @@ <context line>      optional chunk marker; context marker moves the search cursor after that existing line",
			" context line               space prefix; old and new text",
			"-removed line               removed old text",
			"+added line                 added new text",
			"*** End of File             optional EOF-sensitive match / append marker",
			"",
			"RULES",
			"- One section per touched path per patch.",
			"- Read files before writing Update File patches so context and removed lines match current content.",
			"- Use context body lines for positional inserts. A pure + update chunk appends to EOF.",
			"- Unanchored repeated matches use the first forward match.",
			"- The @@ context marker is not changed by the hunk. To change that line, include it as a -/+ body line.",
			"- Fuzzy matching tolerates minor trailing whitespace, smart quote/dash, and Unicode-space differences; context body lines are kept from the original file.",
			"- If a match fails, read the current file content and retry with corrected lines.",
			"",
			"EXAMPLE",
			"*** Begin Patch",
			"*** Add File: src/new-module.ts",
			'+export const version = "1.0.0";',
			"*** Replace File: src/generated.ts",
			"+export const generated = true;",
			"*** Update File: src/config.ts",
			" export const PORT = 3000;",
			"-export const DEBUG = false;",
			"+export const DEBUG = true;",
			"*** Update File: src/old-name.ts",
			"*** Move to: src/new-name.ts",
			" const handler = () => {}",
			"-module.exports = handler;",
			"+export default handler;",
			"*** Delete File: src/deprecated.ts",
			"*** End Patch",
		].join("\n"),
	}),
});

function createPatchTool(rowState: ReturnType<typeof createToolRowStateStore>) {
	return defineTool<typeof patchParams, ApplyPatchSummary>({
		name: "patch",
		label: "Patch",
		description:
			"Apply a multi-file patch to create, edit, move, and delete files. Use it as the default for hand-authored file mutations across one or many files, including large writes; use shell commands or scripts when they express mechanical bulk changes with fewer tokens and less risk. Invalid sections fail independently when possible.",
		promptSnippet: "Apply multi-file patches to create, edit, move, and delete files",
		promptGuidelines: [
			'Call patch with arguments shaped exactly as { "input": "*** Begin Patch\\n...\\n*** End Patch" }. Do not put the patch body in a JSON key.',
			"Use patch as the default for hand-authored file mutations: creates, replacements, updates, moves, and deletes across one or many files, including large writes.",
			"Use shell commands or scripts when they are the lower-token, clearer, safer representation of mechanical bulk work: copying template trees, moving many files, running generators, or applying repeated transforms. Inspect generated, copied, or scripted results before hand-editing them.",
			"Use one envelope: *** Begin Patch, one or more sections, then *** End Patch.",
			"Use one section per touched path. Include adds, replaces, updates, deletes, and moves together when possible; retry failed sections separately when needed.",
			"Before writing Update File patches, read every file you need to touch so context and removed lines match current content.",
			"In Update File hunks, one leading prefix is syntax: space for context, - for removed text, + for added text. The rest of the line is file text.",
			"Use context body lines for positional inserts. A pure + update chunk appends to EOF.",
			"Unanchored repeated matches use the first forward match. Anchor hunks on distinctive nearby lines when matching could be ambiguous; avoid lone braces or generic repeated lines.",
			"The @@ context marker moves the search cursor after that existing line; the marker line itself is not changed by the hunk.",
			"Move targets must not already exist.",
			"If a match fails, read the current file content and retry with corrected lines.",
		],
		parameters: patchParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const input = params.input.replace(/\r\n/g, "\n").trim();
			const summary = await applyPatch(ctx.cwd, input, signal, async (progress) => {
				await onUpdate?.({
					content: [{ type: "text", text: formatPatchSummary(progress) }],
					details: progress,
				});
			});

			return {
				content: [{ type: "text", text: formatPatchSummary(summary) }],
				details: summary,
			};
		},

		renderCall(args, theme, context) {
			return renderPatchCall(args as { input?: string }, theme, {
				expanded: context.expanded,
				executionStarted: context.executionStarted,
				isPartial: context.isPartial,
				lastComponent: context.lastComponent,
				rowState,
				rowId: context.toolCallId,
				invalidate: context.invalidate,
			});
		},

		renderResult(result, options, theme, context) {
			return renderPatchResult(result, { expanded: options.expanded }, theme, {
				expanded: options.expanded,
				args: context.args as { input?: string },
				lastComponent: context.lastComponent,
				rowState,
				rowId: context.toolCallId,
				invalidate: context.invalidate,
			});
		},
	});
}

export default function patchExtension(pi: ExtensionAPI): void {
	const rowState = createToolRowStateStore(pi, "patch.tool-row-state");
	pi.registerTool(createPatchTool(rowState));

	function configureMutationTools(model: { provider: string; id: string } | undefined): void {
		const active = new Set(pi.getActiveTools());
		const usesGrok = model?.provider.toLowerCase() === "xai" || model?.id.toLowerCase().includes("grok") === true;
		if (usesGrok) {
			active.delete("patch");
			for (const tool of SUPPRESSED_TOOLS) active.add(tool);
		} else {
			active.add("patch");
			for (const tool of SUPPRESSED_TOOLS) active.delete(tool);
		}
		pi.setActiveTools([...active]);
	}

	// AgentToolResult has no isError field, so execute returns are always treated as success.
	// Override via tool_result to flag partial/failed patches as errors for the model and UI.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "patch") return;
		const summary = event.details as ApplyPatchSummary | undefined;
		if (summary) {
			emitTauEvent(pi, "tau:file-mutation.applied", {
				source: "patch",
				toolCallId: event.toolCallId,
				cwd: ctx.cwd,
				status: summary.status,
				changes: summary.changes.map((change) => ({
					path: change.path,
					kind: change.kind,
					move: change.move,
					linesAdded: change.linesAdded,
					linesRemoved: change.linesRemoved,
					snapshotRanges: change.snapshotRanges,
				})),
			});
		}
		if (!summary || summary.status === "completed") return;
		return { isError: true };
	});

	pi.on("session_start", (_event, ctx) => {
		rowState.clear();
		configureMutationTools(ctx.model);
	});

	pi.on("model_select", (event) => {
		configureMutationTools(event.model);
	});
}
