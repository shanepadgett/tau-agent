import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { emitTauEvent } from "../../shared/events.ts";
import { createInjectedContext } from "../../shared/injected-context.ts";
import { discoverAgents } from "../subagent/agents.ts";
import { runSubagent } from "../subagent/run.ts";
import { ContextPanel, ProposalPanel, type ProposalReviewDecision } from "./panel.ts";
import {
	applyContextOperation,
	findProjectRoot,
	loadContextEntries,
	normalizeProjectPath,
	pathExists,
	requireFiles,
	updateContextFiles,
	validSlug,
	writeContextEntry,
	type ContextEntry,
	type ContextOperation,
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

const operationIdentity = {
	id: Type.String({ minLength: 1 }),
	tab: Type.String(),
	concept: Type.String(),
	entry: Type.String(),
	reason: Type.String({ minLength: 1 }),
};
const reviewParams = Type.Object(
	{
		operations: Type.Array(
			Type.Union([
				Type.Object({
					...operationIdentity,
					kind: Type.Literal("create"),
					conceptName: Type.String(),
					conceptDescription: Type.String(),
					description: Type.String(),
					files: Type.Array(Type.String(), { minItems: 1 }),
				}),
				Type.Object({
					...operationIdentity,
					kind: Type.Union([Type.Literal("add-files"), Type.Literal("remove-files")]),
					files: Type.Array(Type.String(), { minItems: 1 }),
				}),
				Type.Object({
					...operationIdentity,
					kind: Type.Literal("replace-file"),
					from: Type.String(),
					to: Type.String(),
				}),
			]),
			{ minItems: 1 },
		),
	},
	{ additionalProperties: false },
);

function result(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

let reviewQueue = Promise.resolve();

async function withReviewLock<T>(task: () => Promise<T>): Promise<T> {
	const previous = reviewQueue;
	let release = () => {};
	reviewQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await task();
	} finally {
		release();
	}
}

function parseChangedFiles(raw: string): Array<{ path: string; status: string; renamedFrom?: string }> {
	const fields = raw.split("\0").filter(Boolean);
	const changes: Array<{ path: string; status: string; renamedFrom?: string }> = [];
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (!field) continue;
		const status = field.slice(0, 2);
		const path = field.slice(3);
		if (status.includes("R") || status.includes("C")) {
			const renamedFrom = fields[index + 1];
			if (renamedFrom) index += 1;
			changes.push({ path, status, ...(renamedFrom ? { renamedFrom } : {}) });
		} else changes.push({ path, status });
	}
	return changes;
}

async function validateContextOperations(
	root: string,
	operations: readonly ContextOperation[],
): Promise<ContextOperation[]> {
	const entries = await loadContextEntries(root);
	const ids = new Set(entries.map((entry) => entry.id));
	const normalized: ContextOperation[] = [];
	for (const operation of operations) {
		const id = operation.id.trim();
		const reason = operation.reason.trim();
		if (!id) throw new Error("Context operation id is required");
		if (!reason) throw new Error(`Context operation reason is required: ${id}`);
		const tab = validSlug(operation.tab, "Context tab");
		const concept = validSlug(operation.concept, "Context concept");
		const entry = validSlug(operation.entry, "Context entry");
		const contextId = `${tab}/${concept}/${entry}`;
		if (operation.kind === "create") {
			if (ids.has(contextId)) throw new Error(`Context entry already exists: ${contextId}`);
			if (!operation.conceptName.trim()) throw new Error(`Context concept name is required: ${id}`);
			if (!operation.description.trim()) throw new Error(`Context entry description is required: ${id}`);
			ids.add(contextId);
			normalized.push({
				...operation,
				id,
				reason,
				tab,
				concept,
				entry,
				conceptName: operation.conceptName.trim(),
				conceptDescription: operation.conceptDescription.trim(),
				description: operation.description.trim(),
				files: await requireFiles(root, operation.files),
			});
			continue;
		}
		const current = entries.find((item) => item.id === contextId);
		if (!current) throw new Error(`Unknown context entry: ${contextId}`);
		if (operation.kind === "replace-file") {
			const from = normalizeProjectPath(root, operation.from);
			if (!current.files.includes(from)) throw new Error(`Context entry does not contain: ${from}`);
			const [to] = await requireFiles(root, [operation.to]);
			normalized.push({ ...operation, id, reason, tab, concept, entry, from, to });
			continue;
		}
		const files =
			operation.kind === "add-files"
				? await requireFiles(root, operation.files)
				: operation.files.map((path) => normalizeProjectPath(root, path));
		if (operation.kind === "remove-files" && current.files.filter((path) => !files.includes(path)).length === 0)
			throw new Error(`Context operation would empty entry: ${contextId}`);
		if (operation.kind === "remove-files") {
			const unknown = files.find((path) => !current.files.includes(path));
			if (unknown) throw new Error(`Context entry does not contain: ${unknown}`);
		}
		normalized.push({ ...operation, id, reason, tab, concept, entry, files });
	}
	return normalized;
}

async function maintain(pi: ExtensionAPI, ctx: ExtensionCommandContext, root: string, request: string): Promise<void> {
	const discovery = await discoverAgents(root, ctx.isProjectTrusted());
	const definition = discovery.agents.get("context-maintenance");
	if (!definition) throw new Error("Built-in context-maintenance subagent is unavailable");
	const existing = await loadContextEntries(root);
	const controller = new AbortController();
	const response = await runSubagent({
		definition,
		task: `Maintain repository context for this request:\n${request}\n\nExisting entries:\n${JSON.stringify(
			existing.map(({ id, description, files }) => ({ id, description, files })),
			null,
			2,
		)}`,
		ctx,
		thinkingLevel: pi.getThinkingLevel(),
		signal: controller.signal,
	});
	if (response.details.status !== "completed") throw new Error(response.content);
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
					"Treat the autoread files as the authoritative project context and current snapshots. Do not reread them or search for coverage around them. Start work from them immediately. Explore outside them only when the user's request or concrete evidence in those files requires missing code or information.",
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
		description: "Research, review, and maintain repository context entries",
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
			ctx.ui.setStatus("context-manage", "maintaining contexts");
			try {
				await maintain(pi, ctx, root, args.trim());
			} catch (error) {
				ctx.ui.notify(
					`Context maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			} finally {
				ctx.ui.setStatus("context-manage", undefined);
			}
		},
	});

	pi.registerTool({
		name: "context_changes",
		label: "Context Changes",
		description: "Report uncommitted repository paths for context maintenance.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, signal, _update, ctx) {
			if (!ctx.isProjectTrusted()) throw new Error("Context changes require a trusted project");
			const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, signal });
			if (rootResult.code !== 0) throw new Error("No Git repository found");
			const root = rootResult.stdout.trim();
			const status = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
				cwd: root,
				signal,
			});
			if (status.code !== 0) throw new Error(status.stderr.trim() || "Unable to read Git status");
			return result({ root, changes: parseChangedFiles(status.stdout) });
		},
	});
	pi.registerTool({
		name: "context_review",
		label: "Context Review",
		description: "Present context maintenance operations for user approval and apply only selected operations.",
		parameters: reviewParams,
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Context review requires TUI mode");
			if (!ctx.isProjectTrusted()) throw new Error("Context review requires a trusted project");
			const rawOperations = params.operations as ContextOperation[];
			if (new Set(rawOperations.map((operation) => operation.id)).size !== rawOperations.length)
				throw new Error("Context operation ids must be unique");
			const root = await findProjectRoot(ctx.cwd);
			const operations = await validateContextOperations(root, rawOperations);
			if (new Set(operations.map((operation) => operation.id)).size !== operations.length)
				throw new Error("Context operation ids must be unique after trimming");
			ctx.ui.setWorkingVisible(false);
			try {
				return await withReviewLock(async () => {
					const decision = await ctx.ui.custom<ProposalReviewDecision>(
						(tui, theme, _keys, done) => new ProposalPanel(tui, theme, operations, done),
					);
					if (decision.kind === "rejected") return result(decision);
					if (decision.kind === "feedback") {
						const feedback = await ctx.ui.editor(
							decision.scope === "batch" ? "Context proposal feedback" : `Feedback for ${decision.operationId}`,
							"",
						);
						return result(
							feedback?.trim()
								? { ...decision, text: feedback.trim() }
								: { kind: "rejected", reason: "Feedback cancelled" },
						);
					}
					for (const operation of decision.operations) await applyContextOperation(root, operation);
					return result({
						kind: "applied" as const,
						operationIds: decision.operations.map((operation) => operation.id),
					});
				});
			} finally {
				ctx.ui.setWorkingVisible(true);
			}
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
					systemPrompt: `${event.systemPrompt}\n\nTreat the autoread files as the authoritative project context and current snapshots. Do not reread them or search for coverage around them. Start work from them immediately. Explore outside them only when the user's request or concrete evidence in those files requires missing code or information.`,
				}
			: undefined,
	);
}
