import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { emitTauEvent } from "../../shared/events.ts";
import { createInjectedContext } from "../../shared/injected-context.ts";
import { discoverAgents } from "../subagent/agents.ts";
import { runSubagent } from "../subagent/run.ts";
import { ContextPanel, ProposalPanel } from "./panel.ts";
import {
	findProjectRoot,
	loadContextEntries,
	normalizeProjectPath,
	pathExists,
	requireFiles,
	updateContextFiles,
	validSlug,
	writeContextEntry,
	type ContextEntry,
	type ContextProposal,
} from "./definitions.ts";

const identityParams = Type.Object(
	{ tab: Type.String(), concept: Type.String(), entry: Type.String() },
	{ additionalProperties: false },
);
const membershipParams = Type.Object(
	{
		tab: Type.String(),
		concept: Type.String(),
		entry: Type.String(),
		paths: Type.Array(Type.String(), { minItems: 1 }),
	},
	{ additionalProperties: false },
);
const createParams = Type.Object(
	{
		tab: Type.String(),
		concept: Type.String(),
		conceptName: Type.String(),
		conceptDescription: Type.String(),
		entry: Type.String(),
		description: Type.String(),
		paths: Type.Array(Type.String(), { minItems: 1 }),
	},
	{ additionalProperties: false },
);

function result(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

async function research(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	root: string,
	request: string,
): Promise<ContextProposal[]> {
	const discovery = await discoverAgents(root, ctx.isProjectTrusted());
	const definition = discovery.agents.get("context-research");
	if (!definition) throw new Error("Built-in context-research subagent is unavailable");
	const existing = await loadContextEntries(root);
	const controller = new AbortController();
	const response = await runSubagent({
		definition,
		task: `Research context entries for this request:\n${request}\n\nExisting entries:\n${JSON.stringify(
			existing.map(({ id, description, files }) => ({ id, description, files })),
			null,
			2,
		)}\n\nReturn only a JSON array. Each item must contain tab, concept, conceptName, conceptDescription, entry, description, and files.`,
		ctx,
		thinkingLevel: pi.getThinkingLevel(),
		signal: controller.signal,
	});
	const text = response.content
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) throw new Error("Context research returned invalid JSON");
	const proposals: ContextProposal[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object") throw new Error("Context research returned an invalid proposal");
		const value = item as Record<string, unknown>;
		if (
			["tab", "concept", "conceptName", "conceptDescription", "entry", "description"].some(
				(key) => typeof value[key] !== "string",
			) ||
			!Array.isArray(value.files) ||
			value.files.some((file) => typeof file !== "string")
		)
			throw new Error("Context research returned an invalid proposal");
		proposals.push({
			tab: validSlug(value.tab as string, "Context tab"),
			concept: validSlug(value.concept as string, "Context concept"),
			conceptName: (value.conceptName as string).trim(),
			conceptDescription: (value.conceptDescription as string).trim(),
			entry: validSlug(value.entry as string, "Context entry"),
			description: (value.description as string).trim(),
			files: await requireFiles(root, value.files as string[]),
		});
	}
	return proposals;
}

export default function contextExtension(pi: ExtensionAPI): void {
	let active: ContextEntry[] = [];

	pi.registerCommand("context", {
		description: "Select repository context entries and inject their files",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.isProjectTrusted()) {
				ctx.ui.notify("/context requires a trusted TUI project", "warning");
				return;
			}
			await ctx.waitForIdle();
			const root = await findProjectRoot(ctx.cwd);
			const entries = await loadContextEntries(root);
			const firstEntry = entries[0];
			if (!firstEntry) {
				ctx.ui.notify(`No context entries found in ${join(root, ".pi", "contexts")}`, "warning");
				return;
			}
			const selected = await ctx.ui.custom<ContextEntry[] | undefined>(
				(tui, theme, _keys, done) => new ContextPanel(tui, theme, entries, done),
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-center",
						width: "70%",
						minWidth: 64,
						maxHeight: "80%",
						margin: 2,
					},
				},
			);
			if (!selected?.length) return;
			active = selected;
			pi.appendEntry("tau.context-selection", { ids: selected.map((entry) => entry.id) });
			const files = [...new Set(selected.flatMap((entry) => entry.files))].sort();
			pi.sendMessage(
				createInjectedContext(
					[
						"# Project context",
						"",
						...selected.map(
							(entry) => `- ${entry.tab} / ${entry.conceptName} / ${entry.name}: ${entry.description}`,
						),
					].join("\n"),
					{ source: "context", title: "Project context" },
				),
			);
			emitTauEvent(pi, "tau:autoread.requested", {
				source: "context",
				title: "Project context",
				cwd: root,
				batchId: randomUUID(),
				files: files.map((path) => ({ path })),
			});
		},
	});

	pi.registerCommand("context-manage", {
		description: "Research and approve repository context entries",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /context-manage <context idea>", "warning");
				return;
			}
			if (ctx.mode !== "tui" || !ctx.isProjectTrusted()) {
				ctx.ui.notify("/context-manage requires a trusted TUI project", "warning");
				return;
			}
			await ctx.waitForIdle();
			const root = await findProjectRoot(ctx.cwd);
			ctx.ui.setStatus("context-manage", "researching contexts");
			let proposals: ContextProposal[];
			try {
				proposals = await research(pi, ctx, root, args.trim());
			} catch (error) {
				ctx.ui.notify(
					`Context research failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			} finally {
				ctx.ui.setStatus("context-manage", undefined);
			}
			if (proposals.length === 0) {
				ctx.ui.notify("No context entries proposed", "info");
				return;
			}
			const selected = await ctx.ui.custom<ContextProposal[] | undefined>(
				(tui, theme, _keys, done) => new ProposalPanel(tui, theme, proposals, done, () => {}),
			);
			if (!selected?.length) return;
			const existingIds = new Set((await loadContextEntries(root)).map((entry) => entry.id));
			const selectedIds = selected.map((proposal) => `${proposal.tab}/${proposal.concept}/${proposal.entry}`);
			if (new Set(selectedIds).size !== selectedIds.length) {
				ctx.ui.notify("Context proposals contain duplicate entries", "error");
				return;
			}
			const collision = selectedIds.find((id) => existingIds.has(id));
			if (collision) {
				ctx.ui.notify(`Context entry already exists: ${collision}`, "error");
				return;
			}
			for (const proposal of selected) await writeContextEntry(root, proposal, false);
			ctx.ui.notify(`Created ${selected.length} context ${selected.length === 1 ? "entry" : "entries"}`, "info");
		},
	});

	pi.registerTool({
		name: "context_list",
		label: "Context List",
		description: "List repository context tabs, concepts, entries, and file counts.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, _signal, _update, ctx) {
			const root = await findProjectRoot(ctx.cwd);
			return result(
				(await loadContextEntries(root)).map(({ id, description, files }) => ({
					id,
					description,
					fileCount: files.length,
				})),
			);
		},
	});
	pi.registerTool({
		name: "context_get",
		label: "Context Get",
		description: "Get one repository context entry and its files.",
		parameters: identityParams,
		async execute(_id, params, _signal, _update, ctx) {
			const root = await findProjectRoot(ctx.cwd);
			const id = `${params.tab}/${params.concept}/${params.entry}`;
			const entry = (await loadContextEntries(root)).find((item) => item.id === id);
			if (!entry) throw new Error(`Unknown context entry: ${id}`);
			return result(entry);
		},
	});
	pi.registerTool({
		name: "context_create",
		label: "Context Create",
		description: "Create one validated repository context entry.",
		parameters: createParams,
		async execute(_id, params, _signal, _update, ctx) {
			const root = await findProjectRoot(ctx.cwd);
			await writeContextEntry(root, { ...params, files: params.paths }, false);
			return result({ created: `${params.tab}/${params.concept}/${params.entry}` });
		},
	});
	pi.registerTool({
		name: "context_add_files",
		label: "Context Add Files",
		description: "Add existing project files to one context entry.",
		parameters: membershipParams,
		async execute(_id, params, _signal, _update, ctx) {
			const root = await findProjectRoot(ctx.cwd);
			return result({
				added: await updateContextFiles(root, params.tab, params.concept, params.entry, params.paths, "add"),
			});
		},
	});
	pi.registerTool({
		name: "context_remove_files",
		label: "Context Remove Files",
		description: "Remove project files from one context entry.",
		parameters: membershipParams,
		async execute(_id, params, _signal, _update, ctx) {
			const root = await findProjectRoot(ctx.cwd);
			return result({
				removed: await updateContextFiles(root, params.tab, params.concept, params.entry, params.paths, "remove"),
			});
		},
	});
	pi.registerTool({
		name: "context_check",
		label: "Context Check",
		description: "Report context memberships and existence for exact project paths.",
		parameters: Type.Object({ paths: Type.Array(Type.String(), { minItems: 1 }) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const root = await findProjectRoot(ctx.cwd);
			const entries = await loadContextEntries(root);
			return result(
				await Promise.all(
					params.paths.map(async (input) => {
						const path = normalizeProjectPath(root, input);
						return {
							path,
							exists: await pathExists(join(root, path)),
							memberships: entries.filter((entry) => entry.files.includes(path)).map((entry) => entry.id),
						};
					}),
				),
			);
		},
	});
	pi.registerTool({
		name: "context_audit",
		label: "Context Audit",
		description: "Report context paths that no longer exist.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, _signal, _update, ctx) {
			const root = await findProjectRoot(ctx.cwd);
			const entries = await loadContextEntries(root);
			const stale = (
				await Promise.all(
					entries.flatMap((entry) =>
						entry.files.map(async (path) =>
							(await pathExists(join(root, path))) ? undefined : { entry: entry.id, path },
						),
					),
				)
			).filter((item) => item !== undefined);
			return result({ stale });
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const root = await findProjectRoot(ctx.cwd);
		const entries = await loadContextEntries(root);
		let selectionData: unknown;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "tau.context-selection") selectionData = entry.data;
		}
		const ids =
			typeof selectionData === "object" &&
			selectionData !== null &&
			"ids" in selectionData &&
			Array.isArray(selectionData.ids)
				? selectionData.ids.filter((id: unknown): id is string => typeof id === "string")
				: [];
		active = entries.filter((entry) => ids.includes(entry.id));
	});
	pi.on("before_agent_start", (event) =>
		active.length
			? {
					systemPrompt: `${event.systemPrompt}\n\nThe user selected repository context entries: ${active.map((entry) => entry.id).join(", ")}. Their files were injected through Tau autoread. Start there. Search outside them only when the request, code references, or validation requires it.`,
				}
			: undefined,
	);
}
