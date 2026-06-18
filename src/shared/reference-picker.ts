import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createGitRunner, type GitRunner } from "./git.ts";

const REFERENCES_DIR = join(homedir(), ".local", "share", "tau-agent", "references");
const CLONE_TIMEOUT_MS = 300_000;
const UPDATE_TIMEOUT_MS = 120_000;

export interface ReferenceItem {
	name: string;
	path: string;
	dirty: boolean;
}

type ReferencePanelAction =
	| { action: "cancel" }
	| { action: "new" }
	| { action: "update" }
	| { action: "submit"; selected: ReferenceItem[] };

export async function pickReferences(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<ReferenceItem[] | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Reference picker requires TUI mode.", "error");
		return undefined;
	}

	const git = createGitRunner(pi, ctx);
	let references = await loadReferences(git);

	while (true) {
		const result = await showReferencePanel(ctx, references);
		if (result.action === "cancel") return undefined;

		if (result.action === "new") {
			await addReference(pi, ctx);
			references = await loadReferences(git);
			continue;
		}

		if (result.action === "update") {
			await updateReferences(git, ctx, references);
			references = await loadReferences(git);
			continue;
		}

		return result.selected;
	}
}

export async function addReference(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawUrl = ""): Promise<void> {
	const url = rawUrl.trim();
	if (!url) {
		await promptAndCloneReference(pi, ctx);
		return;
	}

	await cloneReference(createGitRunner(pi, ctx), ctx, url);
}

export function referenceLines(references: readonly ReferenceItem[]): string[] {
	if (references.length === 0) return [];

	// lean: paths-only; dump repo contents only if targeted reads prove insufficient.
	return [
		"Reference repositories:",
		...references.map((ref) => `- ${ref.name}: ${ref.path}${ref.dirty ? " (dirty)" : ""}`),
		"",
		"Use references as read-only examples. Search/read only files needed for this request.",
	];
}

async function showReferencePanel(
	ctx: ExtensionCommandContext,
	references: readonly ReferenceItem[],
): Promise<ReferencePanelAction> {
	const root = referenceRoot();

	return ctx.ui.custom<ReferencePanelAction>((tui, theme, _keybindings, done) => {
		let cursor = 0;
		const selected = new Set<string>();

		function toggleCurrent(): void {
			const item = references[cursor];
			if (!item) return;
			if (!selected.delete(item.path)) selected.add(item.path);
			tui.requestRender();
		}

		return {
			render(width: number): string[] {
				const renderWidth = Math.max(1, width);
				const border = theme.fg("accent", "─".repeat(renderWidth));
				const lines = [border];

				lines.push(truncateToWidth(theme.fg("accent", theme.bold("References")), renderWidth));
				lines.push(truncateToWidth(theme.fg("dim", `${references.length} folder(s) in ${root}`), renderWidth));
				lines.push("");

				if (references.length === 0) {
					lines.push(truncateToWidth(theme.fg("muted", "No reference folders. Press n for new."), renderWidth));
				} else {
					if (references.some((item) => item.dirty)) {
						lines.push(
							truncateToWidth(theme.fg("warning", "Warning: dirty reference repos are read-only."), renderWidth),
						);
						lines.push("");
					}

					for (const [index, item] of references.entries()) {
						const active = index === cursor;
						const pointer = active ? theme.fg("accent", "> ") : "  ";
						const box = selected.has(item.path) ? "[x]" : "[ ]";
						const name = item.dirty ? `${item.name} *` : item.name;
						const label = active ? theme.fg("accent", name) : theme.fg(item.dirty ? "warning" : "text", name);
						lines.push(truncateToWidth(`${pointer}${box} ${label}`, renderWidth));
					}
				}

				lines.push("");
				lines.push(
					...wrapTextWithAnsi(
						theme.fg("dim", "↑↓ move • space toggle • enter attach • n new • u update • esc cancel"),
						renderWidth,
					),
				);
				lines.push(border);
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.up)) {
					cursor = Math.max(0, cursor - 1);
					tui.requestRender();
					return;
				}

				if (matchesKey(data, Key.down)) {
					cursor = Math.min(Math.max(0, references.length - 1), cursor + 1);
					tui.requestRender();
					return;
				}

				if (matchesKey(data, Key.space)) {
					toggleCurrent();
					return;
				}

				if (matchesKey(data, Key.enter)) {
					const picked = references.filter((item) => selected.has(item.path));
					if (picked.length > 0) done({ action: "submit", selected: picked });
					return;
				}

				if (data === "n" || data === "N") {
					done({ action: "new" });
					return;
				}

				if (data === "u" || data === "U") {
					done({ action: "update" });
					return;
				}

				if (matchesKey(data, Key.escape)) done({ action: "cancel" });
			},
		};
	});
}

async function promptAndCloneReference(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Use /reference new <git-url> in non-interactive mode.", "error");
		return;
	}

	const url = await ctx.ui.input("New reference", "Git URL");
	if (!url?.trim()) {
		ctx.ui.notify("New reference cancelled.", "info");
		return;
	}

	await cloneReference(createGitRunner(pi, ctx), ctx, url);
}

async function cloneReference(git: GitRunner, ctx: ExtensionCommandContext, rawUrl: string): Promise<void> {
	const url = rawUrl.trim();
	if (!url) {
		ctx.ui.notify("Git URL is required.", "error");
		return;
	}

	let name: string;
	try {
		name = referenceNameFromUrl(url);
	} catch (error) {
		ctx.ui.notify(errorText(error), "error");
		return;
	}

	const root = referenceRoot();
	const target = join(root, name);
	await mkdir(root, { recursive: true });

	ctx.ui.setStatus("reference", `cloning ${name}`);
	try {
		await git.run(["clone", url, target], { cwd: root, timeout: CLONE_TIMEOUT_MS });
		ctx.ui.notify(`Added ${name} to ${target}`, "info");
	} catch (error) {
		ctx.ui.notify(`New reference failed: ${errorText(error)}`, "error");
	} finally {
		ctx.ui.setStatus("reference", undefined);
	}
}

async function loadReferences(git: GitRunner): Promise<ReferenceItem[]> {
	const root = referenceRoot();
	await mkdir(root, { recursive: true });

	const refs = (await readdir(root, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => ({ name: entry.name, path: join(root, entry.name) }))
		.sort((left, right) => left.name.localeCompare(right.name));

	const references: ReferenceItem[] = [];
	for (const ref of refs) {
		references.push({
			...ref,
			dirty: (await git.run(["status", "--porcelain=v1"], { cwd: ref.path, optional: true })).length > 0,
		});
	}
	return references;
}

async function updateReferences(
	git: GitRunner,
	ctx: ExtensionCommandContext,
	references: readonly ReferenceItem[],
): Promise<void> {
	if (references.length === 0) {
		ctx.ui.notify("No references.", "info");
		return;
	}

	ctx.ui.setStatus("reference", `updating ${references.length} reference(s)`);
	const updated: string[] = [];
	const failures: string[] = [];

	try {
		for (const ref of references) {
			try {
				await git.run(["pull", "--ff-only", "--quiet"], { cwd: ref.path, timeout: UPDATE_TIMEOUT_MS });
				updated.push(ref.path);
			} catch (error) {
				failures.push(`${ref.name}: ${errorText(error)}`);
			}
		}
	} finally {
		ctx.ui.setStatus("reference", undefined);
	}

	if (updated.length > 0) ctx.ui.notify(`Updated ${updated.length} reference(s).`, "info");
	if (failures.length > 0) ctx.ui.notify(`Reference update failed:\n${failures.join("\n")}`, "error");
}

function referenceRoot(): string {
	return REFERENCES_DIR;
}

function referenceNameFromUrl(url: string): string {
	const withoutDecorations = url
		.trim()
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "");
	const name = basename(withoutDecorations)
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");

	if (!name || name === "." || name === "..") throw new Error("Could not derive reference folder name from Git URL.");
	return name;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
