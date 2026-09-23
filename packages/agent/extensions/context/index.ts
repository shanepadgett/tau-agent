import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { prepareFileInjection } from "@shanepadgett/tau-agent";
import { findProjectRoot, loadContextEntries, type ContextEntry, type ContextShowTarget } from "./definitions.ts";
import { ContextPanel } from "./panel.ts";

const CONTEXT_BRIEF_TYPE = "tau.context.brief";

const SHOW_RANK = {
	signature: 0,
	signatureWithDocs: 1,
	declaration: 2,
	declarationWithImports: 3,
} as const;

function collectInjectionPlan(selected: readonly ContextEntry[]): {
	read: string[];
	shows: ContextShowTarget[];
	outline: string[];
	references: string[];
} {
	const read = new Set(selected.flatMap((entry) => entry.read));
	const showByKey = new Map<string, ContextShowTarget>();
	for (const entry of selected) {
		for (const target of entry.show) {
			if (read.has(target.path)) continue;
			const key = `${target.path}\0${target.name}`;
			const existing = showByKey.get(key);
			if (!existing || SHOW_RANK[target.view] > SHOW_RANK[existing.view]) showByKey.set(key, target);
		}
	}
	const shows = [...showByKey.values()].sort(
		(left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name),
	);
	const outline = new Set(selected.flatMap((entry) => entry.outline).filter((path) => !read.has(path)));
	const references = [
		...new Set(selected.flatMap((entry) => entry.references).filter((path) => !read.has(path) && !outline.has(path))),
	].sort((left, right) => left.localeCompare(right));
	return {
		read: [...read].sort((left, right) => left.localeCompare(right)),
		shows,
		outline: [...outline].sort((left, right) => left.localeCompare(right)),
		references,
	};
}

function contextBriefContent(selected: readonly ContextEntry[], references: readonly string[], failed: number): string {
	const authority =
		failed === 0
			? "The complete files, show targets, and outlines that follow are current. Treat them as authoritative and do not read them again. Show rows are declaration slices only — do not assume the rest of the file is loaded. Use a ranged read for bodies an outline omits, and re-read a file only after you change it."
			: "Successful complete-file, show, and outline rows that follow are current; failed rows contain no source context. Treat successful rows as authoritative and do not read them again. Show rows are declaration slices only — do not assume the rest of the file is loaded. Use a ranged read for bodies an outline omits, and re-read a file only after you change it.";
	return [
		"Active repository context, injected once from the current catalog:",
		...selected.map((entry) => `- ${entry.id}: ${entry.description}`),
		"",
		"Unloaded references:",
		...(references.length ? references.map((path) => `- ${path}`) : ["(none)"]),
		"",
		authority,
	].join("\n");
}

async function injectSelectedContext(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	root: string,
	selected: readonly ContextEntry[],
): Promise<void> {
	const plan = collectInjectionPlan(selected);
	const prepared = await prepareFileInjection(pi, {
		cwd: root,
		source: "context",
		batchId: randomUUID(),
		files: [
			...plan.read.map((path) => ({ path, mode: "full" as const })),
			...plan.shows.map((target) => ({
				path: target.path,
				mode: "show" as const,
				name: target.name,
				view: target.view,
			})),
			...plan.outline.map((path) => ({ path, mode: "outline" as const })),
		],
	});
	const failed = prepared.filter((message) => message.details.status === "failed").length;
	pi.sendMessage({
		customType: CONTEXT_BRIEF_TYPE,
		content: contextBriefContent(selected, plan.references, failed),
		display: false,
	});
	for (const message of prepared) pi.sendMessage(message);
	if (failed > 0) {
		ctx.ui.notify(
			`Injected ${prepared.length - failed} of ${prepared.length} files from ${selected.length} context entries; ${failed} failed`,
			"warning",
		);
	}
}

export default function contextExtension(pi: ExtensionAPI): void {
	pi.registerCommand("context", {
		description: "Inject repository context entries into the conversation",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.isProjectTrusted()) {
				ctx.ui.notify("/context requires a trusted TUI project", "warning");
				return;
			}
			await ctx.waitForIdle();
			const root = await findProjectRoot(ctx.cwd);
			const entries = await loadContextEntries(root);
			if (!entries[0]) {
				ctx.ui.notify(`No context entries found in ${join(root, ".pi", "contexts")}`, "warning");
				return;
			}
			const selected = await ctx.ui.custom<ContextEntry[] | undefined>(
				(tui, theme, _keys, done) => new ContextPanel(tui, theme, entries, done),
				{
					overlay: true,
					overlayOptions: { anchor: "top-center", width: "70%", minWidth: 64, maxHeight: "80%", margin: 2 },
				},
			);
			if (selected === undefined || selected.length === 0) return;
			await injectSelectedContext(pi, ctx, root, selected);
		},
	});
}
