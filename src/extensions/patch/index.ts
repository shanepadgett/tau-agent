import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { emitTauEvent } from "../../shared/events.js";
import { type ApplyPatchSummary, applyPatch, deriveStats } from "./executor.ts";
import { renderPatchCall, renderPatchResult } from "./render.ts";

const SUPPRESSED_TOOLS = new Set(["edit", "write"]);

const patchParams = Type.Object({
	input: Type.String({
		description: [
			"Apply a structured multi-file patch to create, edit, move, and delete files. Put the full patch text in this field.",
			"",
			"GRAMMAR",
			"*** Begin Patch",
			"*** Add File: <path>",
			"+content line",
			"*** Replace File: <path>",
			"+full file content line",
			"*** Update File: <path>",
			"[*** Move to: <new-path>]     (optional — renames while editing; target must not exist)",
			"[@@ <line from file>]         (optional — anchors search position; see below)",
			" unchanged context line       (space prefix — must match file; preserved in output)",
			"-line to remove               (dash prefix — must match file exactly)",
			"+line to add                   (plus prefix — inserted in place of removed lines)",
			"[*** End of File]             (optional — restricts match to EOF or appends pure insertion at EOF)",
			"*** Delete File: <path>",
			"*** End Patch",
			"",
			"The input must start with exactly *** Begin Patch and end with exactly *** End Patch.",
			"Malformed patch envelopes fail the whole patch. Section-level parse, match, duplicate-path, missing-file, and move-target errors fail those sections while independent valid sections still apply.",
			"",
			"ADD FILE / REPLACE FILE: Only + lines are content. Both write the whole file — new or overwrite. Prefer Add File for new files and Replace File for known full rewrites.",
			"",
			"UPDATE FILE: Context lines (space prefix) and removed lines (- prefix) together form the search pattern. They must match the file exactly. Minor trailing whitespace, smart quote/dash, and Unicode-space differences are tolerated. Context lines are kept unchanged from the original file.",
			"",
			"@@ ANCHOR RULE: The @@ line positions the search cursor AFTER itself. The @@ line is NOT part of the search pattern — do not repeat it as a context line in the same chunk. Use @@ when you have multiple edits in one file, when context lines could match more than one location, or for pure insertions. Unanchored ambiguous matches fail instead of guessing.",
			"",
			"CURSOR ORDERING: The cursor advances forward only — it never moves backward. Order chunks top-to-bottom in file order. After a chunk matches, the cursor sits past it permanently; text above the match (including earlier anchors) is unreachable by later chunks. Re-read the file if you need to re-anchor earlier.",
			"",
			"ANCHOR VS REMOVAL: The @@ anchor line survives in the file unchanged — it is located, not matched. To delete or modify the anchored line itself, put it as a - line (plus its + replacement) in a separate chunk; never re-anchor the line you want to change. @@ followed by only + lines inserts below the anchor, never replaces it.",
			"",
			"PURE INSERTIONS: A chunk with only + lines must use @@ to insert after an anchor, or *** End of File to append. Pure insertion with neither anchor nor EOF marker is rejected. For EOF append, either put + lines before *** End of File in that chunk or put *** End of File before the + lines.",
			"",
			"MOVE TO: Appears immediately after the Update File header (before any chunk lines). Writes the edited content to the new path and deletes the source. Target must not already exist.",
			"",
			"DELETE FILE: Removes the file. Must be the only line in the section.",
			"",
			"RULES",
			"- One section per path per patch. Never two Add/Replace/Update/Delete sections for the same file.",
			"- Read the file before writing Update File patches so context and removed lines match.",
			"- Use @@ anchors whenever the same context may appear more than once.",
			"- Order @@ chunks top-to-bottom: the cursor never moves backward after a match.",
			"- The @@ anchor line survives in the file. To delete or modify it, use it as a - line in a separate chunk — never re-anchor the line you want to change.",
			"- @@ followed by only + lines inserts below the anchor; it never replaces the anchored line. To modify a line, pair -old/+new instead.",
			"- Pure insertions must use @@ or *** End of File.",
			"- If a match fails, read the current file content and retry with corrected lines.",
			"- Only + prefixed lines are file content in Add File and Replace File sections.",
			"- Empty + line in Add File = blank line in the file. Line with just + = blank line.",
			"",
			"EXAMPLE — multi-operation patch (create, edit, move, delete):",
			"*** Begin Patch",
			"*** Add File: src/new-module.ts",
			'+export const version = "1.0.0";',
			"+export function init() {",
			"+\treturn version;",
			"+}",
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
			"",
			"EXAMPLE — pure insertion using @@ anchor:",
			"*** Begin Patch",
			"*** Update File: src/app.ts",
			"@@ export function setup() {",
			"+\tinitializePlugins();",
			"*** End Patch",
			"",
			"EXAMPLE — EOF append:",
			"*** Begin Patch",
			"*** Update File: src/app.ts",
			"*** End of File",
			"+export default app;",
			"*** End Patch",
			"",
			"EXAMPLE — multiple edits in one file using @@ anchors:",
			"*** Begin Patch",
			"*** Update File: src/app.ts",
			"@@ export function setup() {",
			"-\treturn null;",
			"+\treturn createApp();",
			"@@ export function teardown() {",
			"-\treturn null;",
			"+\treturn destroyApp();",
			"*** End Patch",
		].join("\n"),
	}),
});

function formatSummary(summary: ApplyPatchSummary): string {
	const s = deriveStats(summary);
	const lines: string[] = [];
	if (summary.status === "failed") {
		lines.push("No changes applied.");
	} else {
		const parts: string[] = [];
		if (s.linesAdded > 0) parts.push(`+${s.linesAdded}`);
		if (s.linesRemoved > 0) parts.push(`-${s.linesRemoved}`);
		const badge = parts.length > 0 ? ` [${parts.join(" ")}]` : "";
		lines.push(`Applied ${s.completedOperations}/${summary.totalSections} sections.${badge}`);
	}

	for (const path of s.added) lines.push(`A ${path}`);
	for (const path of s.replaced) lines.push(`M ${path}`);
	for (const path of s.updated) lines.push(`M ${path}`);
	for (const path of s.deleted) lines.push(`D ${path}`);
	for (const move of s.moved) lines.push(`R ${move.from} -> ${move.to}`);

	if (summary.failures.length > 0) {
		lines.push("Failures:");
		for (const failure of summary.failures) {
			const kind = failure.kind ? `${failure.kind} ` : "";
			const path = failure.path ?? "";
			const chunk =
				failure.chunkIndex && failure.totalChunks ? ` chunk ${failure.chunkIndex}/${failure.totalChunks}` : "";
			const ctx = failure.contextHint ? ` (context: "${failure.contextHint}")` : "";
			lines.push(`- ${kind}${path}${chunk}: ${failure.message}${ctx}`.trim());
		}
	}

	return lines.join("\n");
}

const PATCH_TOOL = defineTool<typeof patchParams, ApplyPatchSummary>({
	name: "patch",
	label: "Patch",
	description:
		"Apply a multi-file patch to create, edit, move, and delete files. This is the only file-mutation tool available. Use it for all file writes, edits, creation, deletion, and moves. Invalid sections fail independently when possible.",
	promptSnippet: "Apply multi-file patches to create, edit, move, and delete files",
	promptGuidelines: [
		"Use patch for all file creation, editing, deletion, and moves. This is the only file-mutation tool.",
		"Prefer one coherent patch call for all file changes in a task. Include adds, replaces, updates, deletes, and moves together when possible; retry failed sections separately when needed.",
		"Before writing your patch, read every file you need to touch. Then batch all edits across all files into one call. Include all adds, updates, moves, and deletes together.",
		"Patch input must start with exactly *** Begin Patch and end with exactly *** End Patch.",
		"Malformed patch envelopes fail the whole patch. Section-level parse, match, duplicate-path, missing-file, and move-target errors fail those sections while independent valid sections still apply.",
		"Read the file before writing Update File patches so context and removed lines match exactly.",
		"Use @@ anchors whenever context could match more than once. Ambiguous unanchored matches fail instead of guessing.",
		"Order @@ chunks top-to-bottom in file order. The cursor advances forward only — text above a previous match is unreachable by later chunks.",
		"The @@ anchor line survives unchanged. To delete or modify the anchored line itself, use it as a - line in a separate chunk; never re-anchor the line you intend to change. @@ plus pure + lines inserts below the anchor, never replaces it.",
		"Pure insertion chunks must use @@ to insert after an anchor, or *** End of File to append. The @@ anchor line is not part of the hunk; edits begin after it.",
		"Use Add File for new files, Replace File for full rewrites of existing files, and Update File for contextual edits only. Add File and Replace File both write whole-file content and may overwrite existing files.",
		"If patch fails on context mismatch, read the current file content and retry with corrected lines.",
	],
	parameters: patchParams,
	executionMode: "sequential",

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const input = params.input.replace(/\r\n/g, "\n").trim();
		const summary = await applyPatch(ctx.cwd, input, signal, async (progress) => {
			await onUpdate?.({
				content: [{ type: "text", text: formatSummary(progress) }],
				details: progress,
			});
		});

		return {
			content: [{ type: "text", text: formatSummary(summary) }],
			details: summary,
		};
	},

	renderCall(args, theme, context) {
		return renderPatchCall(args as { input?: string }, theme, {
			expanded: context.expanded,
			executionStarted: context.executionStarted,
			isPartial: context.isPartial,
		});
	},

	renderResult(result, options, theme, context) {
		return renderPatchResult(result, { expanded: options.expanded }, theme, {
			expanded: options.expanded,
			args: context.args as { input?: string },
		});
	},
});

export default function patchExtension(pi: ExtensionAPI): void {
	pi.registerTool(PATCH_TOOL);

	// AgentToolResult has no isError field, so execute returns are always treated as success.
	// Override via tool_result to flag partial/failed patches as errors for the model and UI.
	pi.on("tool_result", (event, ctx) => {
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

	pi.on("session_start", () => {
		const active = new Set(pi.getActiveTools());
		active.add("patch");
		for (const tool of SUPPRESSED_TOOLS) active.delete(tool);
		pi.setActiveTools([...active]);
	});
}
