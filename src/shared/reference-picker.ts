import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import referenceSettings, { type ReferenceEditor } from "../extensions/reference/settings.ts";
import { createGitRunner, type GitRunner } from "./git.ts";
import { loadTauExtensionSettings } from "./settings/load.ts";
import { formatAge } from "./text.ts";

const REFERENCES_DIR = join(homedir(), ".local", "share", "tau-agent", "references");
const CLONE_TIMEOUT_MS = 300_000;
const UPDATE_TIMEOUT_MS = 120_000;
const BRANCH_PROBE_TIMEOUT_MS = 120_000;
const MAX_BRANCH_CHOICES = 50;

export interface ReferenceItem {
	name: string;
	path: string;
	dirty: boolean;
	branch: string;
}

type ReferencePanelAction =
	| { action: "cancel" }
	| { action: "new" }
	| { action: "delete"; selected: ReferenceItem[] }
	| { action: "submit"; selected: ReferenceItem[] };

type ReferenceUpdateState = "updating" | "updated" | "failed";

interface ReferenceBranch {
	name: string;
	updatedAt: number;
	isDefault: boolean;
}

export async function pickReferences(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<ReferenceItem[] | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Reference picker requires TUI mode.", "error");
		return undefined;
	}

	const git = createGitRunner(pi, ctx);
	const settings = await loadTauExtensionSettings(ctx, referenceSettings);
	let references = await loadReferences(git);
	const selected = new Set<string>();

	while (true) {
		const result = await showReferencePanel(git, ctx, references, selected, settings.editor);
		if (result.action === "cancel") return undefined;

		if (result.action === "new") {
			await addReference(pi, ctx);
			references = await loadReferences(git);
			continue;
		}

		if (result.action === "delete") {
			const ok = await confirmDelete(ctx, result.selected);
			if (ok) {
				const deleted: string[] = [];
				const failures: string[] = [];
				for (const item of result.selected) {
					try {
						await deleteReference(ctx, item.name);
						deleted.push(item.name);
						selected.delete(item.path);
					} catch (error) {
						failures.push(`${item.name}: ${errorText(error)}`);
					}
				}
				if (deleted.length > 0) {
					ctx.ui.notify(`Deleted ${deleted.length} reference${deleted.length === 1 ? "" : "s"}.`, "info");
				}
				if (failures.length > 0) ctx.ui.notify(`Reference delete failed:\n${failures.join("\n")}`, "error");
			}
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
	git: GitRunner,
	ctx: ExtensionCommandContext,
	references: readonly ReferenceItem[],
	selected: Set<string>,
	editor: ReferenceEditor,
): Promise<ReferencePanelAction> {
	const root = referenceRoot();

	return ctx.ui.custom<ReferencePanelAction>((tui, theme, _keybindings, done) => {
		let cursor = 0;
		let items = [...references];
		let filterMode = false;
		const filterInput = new Input();
		let updating = false;
		const updateStates = new Map<string, ReferenceUpdateState>();

		filterInput.onSubmit = () => setFilterMode(false);
		filterInput.onEscape = () => {
			if (filterInput.getValue()) filterInput.setValue("");
			else setFilterMode(false);
			cursor = 0;
			tui.requestRender();
		};

		function visibleItems(): ReferenceItem[] {
			const filter = filterInput.getValue();
			return filter ? fuzzyFilter(items, filter, referenceFilterText) : items;
		}

		function clampCursor(): void {
			cursor = Math.min(cursor, Math.max(0, visibleItems().length - 1));
		}

		function setFilterMode(enabled: boolean): void {
			filterMode = enabled;
			filterInput.focused = enabled;
			clampCursor();
			tui.requestRender();
		}

		function toggleCurrent(): void {
			const item = visibleItems()[cursor];
			if (!item) return;
			if (!selected.delete(item.path)) selected.add(item.path);
			tui.requestRender();
		}

		async function updateVisibleReferences(): Promise<void> {
			if (updating) return;
			const refs = visibleItems();
			if (refs.length === 0) {
				ctx.ui.notify("No references.", "info");
				return;
			}

			updating = true;
			updateStates.clear();
			ctx.ui.setStatus("reference", `updating ${refs.length} reference(s)`);
			tui.requestRender();

			let updated = 0;
			const failures: string[] = [];
			try {
				for (const ref of refs) updateStates.set(ref.path, "updating");
				tui.requestRender();

				await Promise.all(
					refs.map(async (ref) => {
						try {
							await git.run(["pull", "--ff-only", "--quiet"], { cwd: ref.path, timeout: UPDATE_TIMEOUT_MS });
							updated += 1;
							updateStates.set(ref.path, "updated");
						} catch (error) {
							updateStates.set(ref.path, "failed");
							failures.push(`${ref.name}: ${errorText(error)}`);
						}
						tui.requestRender();
					}),
				);

				items = await loadReferences(git);
				clampCursor();
			} finally {
				updating = false;
				ctx.ui.setStatus("reference", undefined);
				tui.requestRender();
			}

			if (updated > 0) ctx.ui.notify(`Updated ${updated} reference(s).`, "info");
			if (failures.length > 0) ctx.ui.notify(`Reference update failed:\n${failures.join("\n")}`, "error");
		}

		function openCurrentReference(): void {
			const item = visibleItems()[cursor];
			if (!item) {
				ctx.ui.notify("No reference highlighted.", "info");
				return;
			}

			openReferenceInEditor(ctx, item, editor);
		}

		return {
			render(width: number): string[] {
				const refs = visibleItems();
				const { border, lines, renderWidth } = panelHeader(
					theme,
					width,
					"References",
					`${refs.length}/${items.length} folder(s) in ${root}`,
				);
				if (filterMode) {
					lines.push(...filterInput.render(renderWidth));
					lines.push("");
				}

				if (items.length === 0) {
					lines.push(truncateToWidth(theme.fg("muted", "No reference folders. Press n for new."), renderWidth));
				} else if (refs.length === 0) {
					lines.push(truncateToWidth(theme.fg("muted", "No matching references."), renderWidth));
				} else {
					if (refs.some((item) => item.dirty)) {
						lines.push(
							truncateToWidth(theme.fg("warning", "Warning: dirty reference repos are read-only."), renderWidth),
						);
						lines.push("");
					}

					for (const [index, item] of refs.entries()) {
						const active = index === cursor;
						const pointer = active ? theme.fg("accent", "> ") : "  ";
						const box = selected.has(item.path) ? "[x]" : "[ ]";
						const name = item.dirty ? `${item.name} *` : item.name;
						const state = updateStates.get(item.path);
						const suffix = state ? ` ${updateIndicator(state)}` : "";
						const label = active ? theme.fg("accent", name) : theme.fg(item.dirty ? "warning" : "text", name);
						const branch = item.branch ? theme.fg("muted", ` (${item.branch})`) : "";
						lines.push(truncateToWidth(`${pointer}${box} ${label}${branch}${suffix}`, renderWidth));
					}
				}

				lines.push("");
				lines.push(
					...wrapTextWithAnsi(
						theme.fg(
							"dim",
							filterMode
								? "↑↓ move • space toggle • enter close filter • esc clear/close filter"
								: "↑↓ move • space toggle • f filter • o open in editor • d delete • n new • u update • enter attach • esc cancel",
						),
						renderWidth,
					),
				);
				lines.push(border);
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (filterMode) {
					if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
						const nextCursor = moveCursor(data, cursor, Math.max(0, visibleItems().length - 1));
						if (nextCursor !== undefined) {
							cursor = nextCursor;
							tui.requestRender();
						}
						return;
					}

					if (matchesKey(data, Key.space)) {
						toggleCurrent();
						return;
					}

					const previousFilter = filterInput.getValue();
					filterInput.handleInput(data);
					if (filterInput.getValue() !== previousFilter) cursor = 0;
					clampCursor();
					tui.requestRender();
					return;
				}

				const nextCursor = moveCursor(data, cursor, Math.max(0, visibleItems().length - 1));
				if (nextCursor !== undefined) {
					cursor = nextCursor;
					tui.requestRender();
					return;
				}

				if (matchesKey(data, Key.space)) {
					toggleCurrent();
					return;
				}

				if (data === "f" || data === "F") {
					setFilterMode(true);
					return;
				}

				if (matchesKey(data, Key.enter)) {
					const picked = visibleItems().filter((item) => selected.has(item.path));
					if (picked.length > 0) done({ action: "submit", selected: picked });
					return;
				}

				if (data === "n" || data === "N") {
					done({ action: "new" });
					return;
				}

				if (data === "u" || data === "U") {
					void updateVisibleReferences();
					return;
				}

				if (data === "o" || data === "O") {
					openCurrentReference();
					return;
				}

				if (data === "d" || data === "D") {
					const picked = visibleItems().filter((item) => selected.has(item.path));
					if (picked.length === 0) {
						ctx.ui.notify("No references selected.", "info");
						return;
					}
					done({ action: "delete", selected: picked });
					return;
				}

				if (matchesKey(data, Key.escape)) done({ action: "cancel" });
			},
		};
	});
}

function referenceFilterText(item: ReferenceItem): string {
	return `${item.name} ${item.branch} ${item.path}`;
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

	let branch: string | undefined;
	if (ctx.mode === "tui") {
		branch = await pickReferenceBranch(git, ctx, url);
		if (!branch) return;
	}

	const root = referenceRoot();
	const target = join(root, name);
	await mkdir(root, { recursive: true });

	ctx.ui.setStatus("reference", `cloning ${name}`);
	try {
		await git.run(["clone", ...(branch ? ["--branch", branch] : []), url, target], {
			cwd: root,
			timeout: CLONE_TIMEOUT_MS,
		});
		ctx.ui.notify(`Added ${name} to ${target}`, "info");
	} catch (error) {
		ctx.ui.notify(`New reference failed: ${errorText(error)}`, "error");
	} finally {
		ctx.ui.setStatus("reference", undefined);
	}
}

async function pickReferenceBranch(
	git: GitRunner,
	ctx: ExtensionCommandContext,
	url: string,
): Promise<string | undefined> {
	ctx.ui.setStatus("reference", "loading remote branches");
	let branches: ReferenceBranch[];
	try {
		branches = await loadRemoteBranches(git, url);
	} catch (error) {
		ctx.ui.notify(`Branch lookup failed: ${errorText(error)}`, "error");
		return undefined;
	} finally {
		ctx.ui.setStatus("reference", undefined);
	}

	if (branches.length === 0) {
		ctx.ui.notify("No remote branches found.", "error");
		return undefined;
	}

	return showBranchPicker(ctx, branches.slice(0, MAX_BRANCH_CHOICES), branches.length);
}

async function loadRemoteBranches(git: GitRunner, url: string): Promise<ReferenceBranch[]> {
	const defaultBranch = await loadDefaultBranch(git, url);
	const tempRoot = await mkdtemp(join(tmpdir(), "tau-reference-"));
	try {
		await git.run(["init", "--quiet"], { cwd: tempRoot, timeout: BRANCH_PROBE_TIMEOUT_MS });
		await git.run(["remote", "add", "origin", url], { cwd: tempRoot, timeout: BRANCH_PROBE_TIMEOUT_MS });
		await git.run(["fetch", "--quiet", "--depth=1", "origin", "+refs/heads/*:refs/remotes/origin/*"], {
			cwd: tempRoot,
			timeout: BRANCH_PROBE_TIMEOUT_MS,
		});
		const output = await git.run(
			[
				"for-each-ref",
				"refs/remotes/origin",
				"--sort=-committerdate",
				"--format=%(refname:strip=3)%00%(committerdate:unix)",
			],
			{ cwd: tempRoot, timeout: BRANCH_PROBE_TIMEOUT_MS },
		);
		const branches = output
			.split("\n")
			.filter(Boolean)
			.map((line): ReferenceBranch => {
				const [branchName = "", seconds = "0"] = line.split("\0");
				return {
					name: branchName,
					updatedAt: Number(seconds) * 1000,
					isDefault: branchName === defaultBranch,
				};
			})
			.filter((branch) => branch.name);

		return branches.sort((left, right) => {
			if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
			return right.updatedAt - left.updatedAt || left.name.localeCompare(right.name);
		});
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

async function loadDefaultBranch(git: GitRunner, url: string): Promise<string | undefined> {
	const output = await git.run(["ls-remote", "--symref", url, "HEAD"], {
		optional: true,
		timeout: BRANCH_PROBE_TIMEOUT_MS,
	});
	const match = /^ref: refs\/heads\/(.+)\s+HEAD$/m.exec(output);
	return match?.[1];
}

async function showBranchPicker(
	ctx: ExtensionCommandContext,
	branches: readonly ReferenceBranch[],
	totalCount: number,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		let cursor = 0;

		return {
			render(width: number): string[] {
				const { border, lines, renderWidth } = panelHeader(
					theme,
					width,
					"Choose branch",
					`${branches.length}/${totalCount} branch(es) shown`,
				);

				for (const [index, branch] of branches.entries()) {
					const active = index === cursor;
					const pointer = active ? theme.fg("accent", "> ") : "  ";
					const suffix = branch.isDefault ? " default" : formatAge(branch.updatedAt);
					const labelText = `${branch.name}  ${suffix}`;
					const label = active
						? theme.fg("accent", labelText)
						: theme.fg(branch.isDefault ? "accent" : "text", labelText);
					lines.push(truncateToWidth(`${pointer}${label}`, renderWidth));
				}

				lines.push("");
				lines.push(...wrapTextWithAnsi(theme.fg("dim", "↑↓ move • enter clone branch • esc cancel"), renderWidth));
				lines.push(border);
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				const nextCursor = moveCursor(data, cursor, branches.length - 1);
				if (nextCursor !== undefined) {
					cursor = nextCursor;
					tui.requestRender();
					return;
				}

				if (matchesKey(data, Key.enter)) {
					done(branches[cursor]?.name);
					return;
				}

				if (matchesKey(data, Key.escape)) done(undefined);
			},
		};
	});
}

function panelHeader(
	theme: Theme,
	width: number,
	titleText: string,
	subtitleText: string,
): { border: string; lines: string[]; renderWidth: number } {
	const renderWidth = Math.max(1, width);
	const border = theme.fg("accent", "─".repeat(renderWidth));
	const lines = [border];
	lines.push(truncateToWidth(theme.fg("accent", theme.bold(titleText)), renderWidth));
	lines.push(truncateToWidth(theme.fg("dim", subtitleText), renderWidth));
	lines.push("");
	return { border, lines, renderWidth };
}

function moveCursor(data: string, cursor: number, max: number): number | undefined {
	if (matchesKey(data, Key.up)) return Math.max(0, cursor - 1);
	if (matchesKey(data, Key.down)) return Math.min(max, cursor + 1);
	return undefined;
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
			branch: await loadCurrentBranch(git, ref.path),
		});
	}
	return references;
}

async function loadCurrentBranch(git: GitRunner, path: string): Promise<string> {
	const branch = await git.run(["branch", "--show-current"], { cwd: path, optional: true });
	if (branch) return branch;
	const commit = await git.run(["rev-parse", "--short", "HEAD"], { cwd: path, optional: true });
	return commit ? `detached ${commit}` : "";
}

function updateIndicator(state: ReferenceUpdateState): string {
	if (state === "updating") return "…";
	if (state === "updated") return "✓";
	return "!";
}

async function confirmDelete(ctx: ExtensionCommandContext, items: readonly ReferenceItem[]): Promise<boolean> {
	const names = items.map((item) => item.name).join(", ");
	return ctx.ui.confirm(
		`Delete ${items.length} reference${items.length === 1 ? "" : "s"}?`,
		`This deletes from disk:\n${names}`,
	);
}

async function deleteReference(ctx: ExtensionCommandContext, name: string): Promise<void> {
	if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
		throw new Error(`Invalid reference name: ${name}`);
	}
	const target = join(REFERENCES_DIR, name);
	if (!target.startsWith(`${REFERENCES_DIR}/`)) {
		throw new Error(`Invalid reference path: ${name}`);
	}
	ctx.ui.setStatus("reference", `deleting ${name}`);
	try {
		await rm(target, { recursive: true, force: true });
	} finally {
		ctx.ui.setStatus("reference", undefined);
	}
}

function openReferenceInEditor(ctx: ExtensionCommandContext, item: ReferenceItem, editor: ReferenceEditor): void {
	const configuredEditor = editor === "default" ? undefined : editor;
	const defaultEditor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
	const command = configuredEditor ?? defaultEditor;
	const child = command
		? spawn(`${command} ${shellQuote(item.path)}`, { detached: true, shell: true, stdio: "ignore" })
		: spawn("code", [item.path], { detached: true, stdio: "ignore" });

	child.once("error", (error) => {
		ctx.ui.notify(`Open reference failed: ${errorText(error)}`, "error");
	});
	child.once("spawn", () => {
		child.unref();
		ctx.ui.notify(`Opening ${item.name}.`, "info");
	});
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
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
