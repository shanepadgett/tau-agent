import { spawn } from "node:child_process";
import { access, mkdir, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { fuzzyFilter, Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createGitRunner, type GitRunner } from "../../shared/git.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { formatAge } from "../../shared/text.ts";
import referenceSettings, { type ReferenceEditor } from "./settings.ts";

const REFERENCES_DIR = join(homedir(), ".local", "share", "tau-agent", "references");
const UPDATE_TIMEOUT_MS = 120_000;
const BRANCH_LOOKUP_TIMEOUT_MS = 15_000;
const BRANCH_SWITCH_TIMEOUT_MS = 120_000;
const CLONE_STALL_MS = 180_000;
const PICKER_VISIBLE_ROWS = 5;

interface ReferenceItem {
	name: string;
	path: string;
	dirty: boolean;
	branch: string;
}

type ReferenceRow =
	| { kind: "reference"; item: ReferenceItem; state?: "updating" | "updated" | "failed" | "switching" }
	| { kind: "clone"; name: string; path: string; progress?: CloneProgress };

interface CloneProgress {
	phase: "receiving" | "resolving" | "updating";
	percent: number;
}

interface ReferenceBranch {
	name: string;
	updatedAt?: number;
	isCurrent: boolean;
}

export default function referenceExtension(pi: ExtensionAPI): void {
	pi.registerCommand("reference", {
		description: "Select local code references or add a new reference repo",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const value = prefix.trimStart();
			if (/\s/.test(value)) return null;

			const item = {
				value: "new",
				label: "new",
				description: "Add a new reference repo",
			};
			return item.value.startsWith(value) ? [item] : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const trimmed = args.trim();
			const [head = "", ...rest] = trimmed.split(/\s+/);
			if (head === "new") {
				const url = rest.join(" ").trim();
				if (!url) {
					ctx.ui.notify("Git URL is required.", "error");
					return;
				}

				await cloneFromCommand(ctx, url);
				return;
			}

			if (trimmed) {
				ctx.ui.notify("Usage: /reference or /reference new <git-url>", "warning");
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify("/reference requires TUI mode. Use /reference new <git-url> to add only.", "error");
				return;
			}

			const settings = await loadTauExtensionSettings(ctx, referenceSettings);
			const references = await showReferencePanel(
				createGitRunner(pi, ctx),
				ctx,
				settings.editor,
				settings.branchChoices,
			);
			if (!references) return;

			const prompt = await ctx.ui.editor("Reference prompt", "");
			if (!prompt?.trim()) {
				ctx.ui.notify("Reference prompt cancelled.", "info");
				return;
			}

			ctx.ui.setEditorText(
				[
					...(references.length === 0
						? []
						: [
								"Reference repositories:",
								...references.map((ref) => `- ${ref.name}: ${ref.path}${ref.dirty ? " (dirty)" : ""}`),
								"",
								"Use references as read-only examples. Search/read only files needed for this request.",
							]),
					"",
					"Request:",
					"",
					prompt.trim(),
				].join("\n"),
			);
		},
	});
}

async function showReferencePanel(
	git: GitRunner,
	ctx: ExtensionCommandContext,
	editor: ReferenceEditor,
	branchChoices: number,
): Promise<ReferenceItem[] | undefined> {
	let initial: ReferenceItem[];
	try {
		initial = await loadReferences(git);
	} catch (error) {
		ctx.ui.notify(`Reference load failed: ${errorText(error)}`, "error");
		initial = [];
	}

	return ctx.ui.custom<ReferenceItem[] | undefined>((tui, theme, _keybindings, done) => {
		let cursor = 0;
		let rows: ReferenceRow[] = initial.map((item) => ({ kind: "reference", item }));
		let filterMode = false;
		let updating = false;
		let deleteConfirm: { items: ReferenceItem[]; label: string } | undefined;
		let cloneInput: Input | undefined;
		let branchPicker: { item: ReferenceItem; branches: ReferenceBranch[]; cursor: number } | undefined;
		const branchCache = new Map<string, ReferenceBranch[]>();
		const selected = new Set<string>();
		const filterInput = new Input();

		filterInput.onSubmit = () => {
			filterMode = false;
			filterInput.focused = false;
			cursor = Math.min(cursor, Math.max(0, visibleRows().length - 1));
			tui.requestRender();
		};
		filterInput.onEscape = () => {
			if (filterInput.getValue()) filterInput.setValue("");
			else {
				filterMode = false;
				filterInput.focused = false;
			}
			cursor = 0;
			tui.requestRender();
		};

		function visibleRows(): ReferenceRow[] {
			const filter = filterInput.getValue();
			return filter
				? fuzzyFilter(rows, filter, (row) =>
						row.kind === "reference"
							? `${row.item.name} ${row.item.branch} ${row.item.path}`
							: `${row.name} ${row.path}`,
					)
				: rows;
		}

		async function reloadReferences(preserveStates = false): Promise<void> {
			const clones = rows.filter((row) => row.kind === "clone");
			const states = new Map(
				preserveStates
					? rows
							.filter((row): row is Extract<ReferenceRow, { kind: "reference" }> => row.kind === "reference")
							.map((row) => [row.item.path, row.state])
					: [],
			);
			rows = [
				...(await loadReferences(git)).map(
					(item): ReferenceRow => ({ kind: "reference", item, state: states.get(item.path) }),
				),
				...clones,
			];
			cursor = Math.min(cursor, Math.max(0, visibleRows().length - 1));
			tui.requestRender();
		}

		function startCloneInput(): void {
			cloneInput = new Input();
			cloneInput.focused = true;
			cloneInput.onSubmit = (value) => {
				cloneInput = undefined;
				void startClone(value);
			};
			cloneInput.onEscape = () => {
				cloneInput = undefined;
				ctx.ui.notify("New reference cancelled.", "info");
				tui.requestRender();
			};
			branchPicker = undefined;
			deleteConfirm = undefined;
			filterMode = false;
			filterInput.focused = false;
			filterInput.setValue("");
			tui.requestRender();
		}

		async function startClone(input: string): Promise<void> {
			const url = input.trim();
			if (!url) {
				ctx.ui.notify("New reference cancelled.", "info");
				tui.requestRender();
				return;
			}

			let name: string;
			try {
				name = referenceNameFromUrl(url);
			} catch (error) {
				ctx.ui.notify(errorText(error), "error");
				return;
			}

			const path = join(REFERENCES_DIR, name);
			if (rows.some((row) => (row.kind === "reference" ? row.item.path : row.path) === path)) {
				ctx.ui.notify(`Reference already exists: ${name}`, "error");
				return;
			}

			const cloneRow: ReferenceRow = { kind: "clone", name, path };
			rows = [...rows, cloneRow].sort(compareReferenceRows);
			cursor = visibleRows().indexOf(cloneRow);
			tui.requestRender();

			try {
				await cloneReference(url, name, path, ctx.signal, (progress) => {
					cloneRow.progress = progress;
					tui.requestRender();
				});
				const item = await loadReference(git, name, path);
				const referenceRow: ReferenceRow = { kind: "reference", item };
				rows = rows
					.map((current) => (referenceRowPath(current) === path ? referenceRow : current))
					.sort(compareReferenceRows);
				cursor = visibleRows().indexOf(referenceRow);
				ctx.ui.notify(`Added ${name} to ${path}`, "info");
			} catch (error) {
				rows = rows.filter((current) => current !== cloneRow);
				ctx.ui.notify(`New reference failed: ${errorText(error)}`, "error");
			} finally {
				cursor = Math.min(cursor, Math.max(0, visibleRows().length - 1));
				tui.requestRender();
			}
		}

		async function updateVisibleReferences(): Promise<void> {
			if (updating) return;
			const refs = visibleRows().filter(
				(row): row is Extract<ReferenceRow, { kind: "reference" }> => row.kind === "reference",
			);
			if (refs.length === 0) {
				ctx.ui.notify("No references.", "info");
				return;
			}

			updating = true;
			let updated = 0;
			const failures: string[] = [];
			for (const row of refs) row.state = "updating";
			tui.requestRender();

			try {
				await Promise.all(
					refs.map(async (row) => {
						try {
							await git.run(["pull", "--ff-only", "--quiet"], {
								cwd: row.item.path,
								timeout: UPDATE_TIMEOUT_MS,
							});
							updated += 1;
							row.state = "updated";
						} catch (error) {
							row.state = "failed";
							failures.push(`${row.item.name}: ${errorText(error)}`);
						}
						tui.requestRender();
					}),
				);
				await reloadReferences(true);
			} finally {
				updating = false;
				tui.requestRender();
			}

			if (updated > 0) ctx.ui.notify(`Updated ${updated} reference(s).`, "info");
			if (failures.length > 0) ctx.ui.notify(`Reference update failed:\n${failures.join("\n")}`, "error");
		}

		async function switchCurrentBranch(row: Extract<ReferenceRow, { kind: "reference" }>): Promise<void> {
			row.state = "switching";
			tui.requestRender();
			let branches = markCurrent(branchCache.get(row.item.path) ?? [], row.item.branch);
			try {
				if (branches.length === 0)
					branches = await loadLocalBranches(git, row.item.path, row.item.branch, branchChoices);
			} catch (error) {
				row.state = undefined;
				tui.requestRender();
				ctx.ui.notify(`Branch lookup failed: ${errorText(error)}`, "error");
				return;
			}

			row.state = undefined;
			if (branches.length === 0) {
				ctx.ui.notify("No remote branches found.", "error");
				tui.requestRender();
				return;
			}

			branchPicker = { item: row.item, branches, cursor: 0 };
			branchCache.set(row.item.path, branches);
			cloneInput = undefined;
			deleteConfirm = undefined;
			tui.requestRender();

			void (async () => {
				try {
					const remoteBranches = await loadRemoteBranches(git, row.item.path, row.item.branch);
					const merged = mergeBranches(branches, remoteBranches, branchChoices);
					branchCache.set(row.item.path, merged);
					if (branchPicker?.item.path === row.item.path) {
						branchPicker.branches = merged;
						branchPicker.cursor = Math.min(branchPicker.cursor, Math.max(0, merged.length - 1));
						tui.requestRender();
					}
				} catch (error) {
					if (branchPicker?.item.path === row.item.path)
						ctx.ui.notify(`Remote branch lookup failed: ${errorText(error)}`, "error");
				}
			})();
		}

		async function switchPickedBranch(branch: string): Promise<void> {
			const item = branchPicker?.item;
			if (!item) return;
			branchPicker = undefined;
			const row = rows.find(
				(current): current is Extract<ReferenceRow, { kind: "reference" }> =>
					current.kind === "reference" && current.item.path === item.path,
			);
			if (!row) {
				ctx.ui.notify("Reference no longer exists.", "error");
				tui.requestRender();
				return;
			}
			row.state = "switching";
			tui.requestRender();
			try {
				await switchBranch(git, item.path, branch);
				branchCache.delete(item.path);
				await reloadReferences();
				ctx.ui.notify(`Switched ${item.name} to ${branch}.`, "info");
			} catch (error) {
				row.state = "failed";
				tui.requestRender();
				ctx.ui.notify(`Branch switch failed: ${errorText(error)}`, "error");
			}
		}

		async function deleteReferences(picked: readonly ReferenceItem[]): Promise<void> {
			const deleted: string[] = [];
			const failures: string[] = [];
			for (const item of picked) {
				try {
					if (!/^[A-Za-z0-9._-]+$/.test(item.name) || item.name === "." || item.name === "..") {
						throw new Error(`Invalid reference name: ${item.name}`);
					}
					const target = join(REFERENCES_DIR, item.name);
					if (!target.startsWith(`${REFERENCES_DIR}/`)) throw new Error(`Invalid reference path: ${item.name}`);
					await rm(target, { recursive: true, force: true });
					deleted.push(item.name);
					selected.delete(item.path);
				} catch (error) {
					failures.push(`${item.name}: ${errorText(error)}`);
				}
			}
			await reloadReferences();
			if (deleted.length > 0)
				ctx.ui.notify(`Deleted ${deleted.length} reference${deleted.length === 1 ? "" : "s"}.`, "info");
			if (failures.length > 0) ctx.ui.notify(`Reference delete failed:\n${failures.join("\n")}`, "error");
		}

		function referencesToDelete(
			refs: readonly ReferenceRow[],
		): { items: ReferenceItem[]; label: string } | undefined {
			const picked = selectedReferences();
			if (picked.length > 0)
				return { items: picked, label: `Delete ${picked.length} repo${picked.length === 1 ? "" : "s"}?` };

			const row = refs[cursor];
			return row?.kind === "reference" ? { items: [row.item], label: `Delete ${row.item.name}?` } : undefined;
		}

		function selectedReferences(): ReferenceItem[] {
			return rows
				.filter((row): row is Extract<ReferenceRow, { kind: "reference" }> => row.kind === "reference")
				.map((row) => row.item)
				.filter((item) => selected.has(item.path));
		}

		function moveCursor(data: string, refs: readonly ReferenceRow[]): boolean {
			if (matchesKey(data, Key.up)) cursor = Math.max(0, cursor - 1);
			else if (matchesKey(data, Key.down)) cursor = Math.min(Math.max(0, refs.length - 1), cursor + 1);
			else return false;
			tui.requestRender();
			return true;
		}

		function toggleSelectedReference(data: string, refs: readonly ReferenceRow[]): boolean {
			if (!matchesKey(data, Key.space)) return false;
			const row = refs[cursor];
			if (row?.kind === "reference" && !selected.delete(row.item.path)) selected.add(row.item.path);
			tui.requestRender();
			return true;
		}

		function startDeleteReferences(refs: readonly ReferenceRow[]): void {
			const picked = referencesToDelete(refs);
			if (!picked) {
				ctx.ui.notify("No reference highlighted or selected.", "info");
				return;
			}

			deleteConfirm = picked;
			cloneInput = undefined;
			branchPicker = undefined;
			tui.requestRender();
		}

		return {
			render(width: number): string[] {
				const refs = visibleRows();
				const renderWidth = Math.max(1, width);
				const border = theme.fg("border", "─".repeat(renderWidth));
				const title = [
					theme.fg("accent", theme.bold("References")),
					theme.fg("dim", REFERENCES_DIR),
					...(selected.size > 0 ? [theme.fg("muted", `${selected.size} selected`)] : []),
				].join(theme.fg("dim", " · "));
				const lines = [border, truncateToWidth(title, renderWidth), ""];

				if (branchPicker) {
					const branchWindow = visibleWindow(branchPicker.branches, branchPicker.cursor, PICKER_VISIBLE_ROWS);
					lines.push(
						truncateToWidth(
							theme.fg("accent", theme.bold(`Choose branch for ${branchPicker.item.name}`)),
							renderWidth,
						),
						truncateToWidth(
							theme.fg("dim", `${branchPicker.branches.length}/${branchChoices} branch choice(s) shown`),
							renderWidth,
						),
						"",
					);
					for (let index = branchWindow.start; index < branchWindow.end; index += 1) {
						const branch = branchPicker.branches[index];
						if (!branch) continue;
						const active = index === branchPicker.cursor;
						const pointer = active ? theme.fg("accent", "→ ") : "  ";
						const suffix = branch.isCurrent
							? " current"
							: branch.updatedAt === undefined
								? "remote"
								: formatAge(branch.updatedAt);
						const labelText = `${branch.name}  ${suffix}`;
						const label = active
							? theme.fg("accent", labelText)
							: theme.fg(branch.isCurrent ? "accent" : "text", labelText);
						lines.push(truncateToWidth(`${pointer}${label}`, renderWidth));
					}
					if (branchWindow.scrolled)
						lines.push(
							theme.fg(
								"muted",
								truncateToWidth(
									`  (${branchPicker.cursor + 1}/${branchPicker.branches.length})`,
									renderWidth,
									"",
								),
							),
						);
					lines.push(
						"",
						...wrapTextWithAnsi(
							theme.fg(
								"dim",
								[keyHint("tui.select.confirm", "switch branch"), keyHint("tui.select.cancel", "cancel")].join(
									" · ",
								),
							),
							renderWidth,
						),
					);
					lines.push(border);
					return lines;
				}

				if (cloneInput) {
					lines.push(truncateToWidth(theme.fg("accent", theme.bold("Git URL")), renderWidth));
					lines.push(...cloneInput.render(renderWidth), "");
				} else if (filterMode) {
					lines.push(...filterInput.render(renderWidth), "");
				} else if (filterInput.getValue()) {
					lines.push(theme.fg("muted", truncateToWidth(`> ${filterInput.getValue()}`, renderWidth, "")), "");
				}

				if (rows.length === 0) {
					lines.push(truncateToWidth(theme.fg("muted", "No reference folders. Press n for new."), renderWidth));
				} else if (refs.length === 0) {
					lines.push(truncateToWidth(theme.fg("muted", "No matching references."), renderWidth));
				} else {
					const rowWindow = visibleWindow(refs, cursor, PICKER_VISIBLE_ROWS);
					if (refs.some((row) => row.kind === "reference" && row.item.dirty)) {
						lines.push(
							truncateToWidth(theme.fg("warning", "Warning: dirty reference repos are read-only."), renderWidth),
						);
						lines.push("");
					}

					for (let index = rowWindow.start; index < rowWindow.end; index += 1) {
						const row = refs[index];
						if (!row) continue;
						const active = index === cursor;
						const pointer = active ? theme.fg("accent", "→ ") : "  ";
						if (row.kind === "clone") {
							const label = active ? theme.fg("accent", row.name) : theme.fg("muted", row.name);
							const suffix = theme.fg(
								"muted",
								row.progress === undefined ? " ↓" : ` ${row.progress.phase} ${row.progress.percent}%`,
							);
							lines.push(truncateToWidth(`${pointer}[ ] ${label}${suffix}`, renderWidth));
							continue;
						}

						const box = selected.has(row.item.path) ? "[x]" : "[ ]";
						const name = row.item.dirty ? `${row.item.name} *` : row.item.name;
						const label = active ? theme.fg("accent", name) : theme.fg(row.item.dirty ? "warning" : "text", name);
						const branch = row.item.branch ? theme.fg("muted", ` (${row.item.branch})`) : "";
						const suffix = row.state
							? ` ${theme.fg(row.state === "failed" ? "error" : row.state === "updated" ? "success" : "muted", row.state === "failed" ? "!" : row.state === "updated" ? "✓" : "…")}`
							: "";
						lines.push(truncateToWidth(`${pointer}${box} ${label}${branch}${suffix}`, renderWidth));
					}
					if (rowWindow.scrolled)
						lines.push(theme.fg("muted", truncateToWidth(`  (${cursor + 1}/${refs.length})`, renderWidth, "")));
				}

				lines.push("");
				if (deleteConfirm) {
					lines.push(
						truncateToWidth(
							`${theme.fg("error", deleteConfirm.label)} ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`,
							renderWidth,
						),
					);
					lines.push(border);
					return lines;
				}

				lines.push(
					...wrapTextWithAnsi(
						theme.fg(
							"dim",
							cloneInput
								? [
										keyHint("tui.select.confirm", "clone default branch"),
										keyHint("tui.select.cancel", "cancel"),
									].join(" · ")
								: filterMode
									? [
											rawKeyHint("space", "toggle"),
											keyHint("tui.select.confirm", "close filter"),
											keyHint("tui.select.cancel", "clear/close filter"),
										].join(" · ")
									: [
											rawKeyHint("space", "toggle"),
											rawKeyHint("c", "clear selected"),
											rawKeyHint("f", "filter"),
											rawKeyHint("o", "open"),
											rawKeyHint("b", "branch"),
											rawKeyHint("d/delete", "delete"),
											rawKeyHint("n", "new"),
											rawKeyHint("u", "update"),
											keyHint("tui.select.confirm", "attach"),
											keyHint("tui.select.cancel", "cancel"),
										].join(" · "),
						),
						renderWidth,
					),
				);
				lines.push(border);
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				const refs = visibleRows();
				if (branchPicker) {
					if (matchesKey(data, Key.up)) {
						branchPicker.cursor = Math.max(0, branchPicker.cursor - 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.down)) {
						branchPicker.cursor = Math.min(branchPicker.branches.length - 1, branchPicker.cursor + 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						const branch = branchPicker.branches[branchPicker.cursor];
						if (branch) void switchPickedBranch(branch.name);
						return;
					}
					if (matchesKey(data, Key.escape)) {
						branchPicker = undefined;
						tui.requestRender();
					}
					return;
				}

				if (cloneInput) {
					cloneInput.handleInput(data);
					tui.requestRender();
					return;
				}

				if (deleteConfirm) {
					if (matchesKey(data, Key.enter)) {
						const picked = deleteConfirm.items;
						deleteConfirm = undefined;
						void deleteReferences(picked);
						return;
					}
					if (matchesKey(data, Key.escape)) {
						deleteConfirm = undefined;
						tui.requestRender();
						return;
					}
					return;
				}

				if (filterMode) {
					if (moveCursor(data, refs)) return;
					if (toggleSelectedReference(data, refs)) return;

					const previousFilter = filterInput.getValue();
					filterInput.handleInput(data);
					if (filterInput.getValue() !== previousFilter) cursor = 0;
					cursor = Math.min(cursor, Math.max(0, visibleRows().length - 1));
					tui.requestRender();
					return;
				}

				if (moveCursor(data, refs)) return;
				if (toggleSelectedReference(data, refs)) return;

				if (data === "c" || data === "C") {
					if (selected.size === 0) ctx.ui.notify("No references selected.", "info");
					else selected.clear();
					tui.requestRender();
					return;
				}

				if (data === "f" || data === "F") {
					filterMode = true;
					filterInput.focused = true;
					tui.requestRender();
					return;
				}

				if (matchesKey(data, Key.enter)) {
					const picked = selectedReferences();
					if (picked.length > 0) done(picked);
					return;
				}

				if (data === "n" || data === "N") {
					startCloneInput();
					return;
				}

				if (data === "u" || data === "U") {
					void updateVisibleReferences();
					return;
				}

				if (data === "b" || data === "B") {
					const row = refs[cursor];
					if (row?.kind === "reference") void switchCurrentBranch(row);
					else ctx.ui.notify("No reference highlighted.", "info");
					return;
				}

				if (data === "o" || data === "O") {
					const row = refs[cursor];
					if (row?.kind !== "reference") {
						ctx.ui.notify("No reference highlighted.", "info");
						return;
					}
					const configuredEditor = editor === "default" ? undefined : editor;
					const defaultEditor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
					const command = configuredEditor ?? defaultEditor;
					const child = command
						? spawn(`${command} ${shellQuote(row.item.path)}`, { detached: true, shell: true, stdio: "ignore" })
						: spawn("code", [row.item.path], { detached: true, stdio: "ignore" });
					child.once("error", (error) => ctx.ui.notify(`Open reference failed: ${errorText(error)}`, "error"));
					child.once("spawn", () => {
						child.unref();
						ctx.ui.notify(`Opening ${row.item.name}.`, "info");
					});
					return;
				}

				if (data === "d" || data === "D" || matchesKey(data, Key.delete)) {
					startDeleteReferences(refs);
					return;
				}

				if (matchesKey(data, Key.escape)) done(undefined);
			},
		};
	});
}

async function cloneFromCommand(ctx: ExtensionCommandContext, url: string): Promise<void> {
	let name: string;
	try {
		name = referenceNameFromUrl(url);
	} catch (error) {
		ctx.ui.notify(errorText(error), "error");
		return;
	}

	const path = join(REFERENCES_DIR, name);
	ctx.ui.setStatus("reference", `cloning ${name}`);
	try {
		await cloneReference(url, name, path, ctx.signal, () => {});
		ctx.ui.notify(`Added ${name} to ${path}`, "info");
	} catch (error) {
		ctx.ui.notify(`New reference failed: ${errorText(error)}`, "error");
	} finally {
		ctx.ui.setStatus("reference", undefined);
	}
}

async function cloneReference(
	url: string,
	name: string,
	target: string,
	signal: AbortSignal | undefined,
	onProgress: (progress: CloneProgress) => void,
): Promise<void> {
	await mkdir(REFERENCES_DIR, { recursive: true });
	if (
		await access(target).then(
			() => true,
			() => false,
		)
	)
		throw new Error(`Reference already exists: ${name}`);
	const temp = join(REFERENCES_DIR, `.clone-${name}-${process.pid}-${Date.now()}`);
	let stderr = "";
	let lastProgress: CloneProgress | undefined;
	let lastOutputAt = Date.now();
	let timedOut = false;

	try {
		const child = spawn("git", ["clone", "--progress", "--single-branch", url, temp], {
			cwd: REFERENCES_DIR,
			stdio: ["ignore", "ignore", "pipe"],
		});
		const stderrStream = child.stderr;
		if (!stderrStream) throw new Error("git clone stderr unavailable.");
		const abort = () => child.kill("SIGTERM");
		if (signal?.aborted) abort();
		signal?.addEventListener("abort", abort, { once: true });

		await new Promise<void>((resolve, reject) => {
			const timer = setInterval(() => {
				if (Date.now() - lastOutputAt < CLONE_STALL_MS) return;
				timedOut = true;
				child.kill("SIGTERM");
			}, 1000);

			stderrStream.setEncoding("utf8");
			stderrStream.on("data", (chunk: string) => {
				lastOutputAt = Date.now();
				stderr = `${stderr}${chunk}`.slice(-4000);
				for (const part of chunk.split(/[\r\n]+/)) {
					const match = /(?<phase>Receiving objects|Resolving deltas|Updating files):\s+(?<percent>\d+)%/.exec(
						part,
					);
					if (!match) continue;
					const phase = cloneProgressPhase(match.groups?.phase);
					if (!phase) continue;
					lastProgress = { phase, percent: Number(match.groups?.percent ?? 0) };
					onProgress(lastProgress);
				}
			});

			child.once("error", (error) => {
				clearInterval(timer);
				signal?.removeEventListener("abort", abort);
				reject(error);
			});
			child.once("close", (code, termSignal) => {
				clearInterval(timer);
				signal?.removeEventListener("abort", abort);
				if (code === 0) resolve();
				else if (timedOut) {
					reject(
						new Error(
							`Clone stalled after ${Math.round(CLONE_STALL_MS / 1000)}s with no git output${lastProgress === undefined ? "" : ` at ${lastProgress.phase} ${lastProgress.percent}%`}.${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
						),
					);
				} else if (signal?.aborted) reject(new Error("Clone cancelled."));
				else reject(new Error(stderr.trim() || `git clone failed with exit code ${code ?? termSignal}`));
			});
		});

		await rename(temp, target);
	} catch (error) {
		await rm(temp, { recursive: true, force: true });
		throw error;
	}
}

function cloneProgressPhase(phase: string | undefined): CloneProgress["phase"] | undefined {
	if (phase === "Receiving objects") return "receiving";
	if (phase === "Resolving deltas") return "resolving";
	if (phase === "Updating files") return "updating";
	return undefined;
}

function compareReferenceRows(left: ReferenceRow, right: ReferenceRow): number {
	return referenceRowName(left).localeCompare(referenceRowName(right));
}

function referenceRowName(row: ReferenceRow): string {
	return row.kind === "reference" ? row.item.name : row.name;
}

function referenceRowPath(row: ReferenceRow): string {
	return row.kind === "reference" ? row.item.path : row.path;
}

function visibleWindow(
	items: readonly unknown[],
	cursor: number,
	maxVisible: number,
): { start: number; end: number; scrolled: boolean } {
	const start = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), items.length - maxVisible));
	const end = Math.min(start + maxVisible, items.length);
	return { start, end, scrolled: start > 0 || end < items.length };
}

async function loadReferences(git: GitRunner): Promise<ReferenceItem[]> {
	await mkdir(REFERENCES_DIR, { recursive: true });
	const refs = (await readdir(REFERENCES_DIR, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".clone-"))
		.map((entry) => ({ name: entry.name, path: join(REFERENCES_DIR, entry.name) }))
		.sort((left, right) => left.name.localeCompare(right.name));

	const references: ReferenceItem[] = [];
	for (const ref of refs) references.push(await loadReference(git, ref.name, ref.path));
	return references;
}

async function loadReference(git: GitRunner, name: string, path: string): Promise<ReferenceItem> {
	const branch = await git.run(["branch", "--show-current"], { cwd: path, optional: true });
	const commit = branch ? "" : await git.run(["rev-parse", "--short", "HEAD"], { cwd: path, optional: true });
	return {
		name,
		path,
		dirty: (await git.run(["status", "--porcelain=v1"], { cwd: path, optional: true })).length > 0,
		branch: branch || (commit ? `detached ${commit}` : ""),
	};
}

async function loadLocalBranches(
	git: GitRunner,
	path: string,
	current: string,
	limit: number,
): Promise<ReferenceBranch[]> {
	const localRefs = await git.run(
		[
			"for-each-ref",
			`--count=${limit}`,
			"--sort=-committerdate",
			"--format=%(refname:strip=3)%00%(committerdate:unix)",
			"refs/remotes/origin",
		],
		{ cwd: path, timeout: BRANCH_LOOKUP_TIMEOUT_MS },
	);
	return parseLocalBranches(localRefs, current).slice(0, limit);
}

async function loadRemoteBranches(git: GitRunner, path: string, current: string): Promise<ReferenceBranch[]> {
	const remoteRefs = await git.run(["ls-remote", "--heads", "origin"], {
		cwd: path,
		timeout: BRANCH_LOOKUP_TIMEOUT_MS,
	});
	return parseRemoteBranchNames(remoteRefs).map((name) => ({ name, isCurrent: name === current }));
}

function mergeBranches(
	localBranches: readonly ReferenceBranch[],
	remoteBranches: readonly ReferenceBranch[],
	limit: number,
): ReferenceBranch[] {
	const byName = new Map(localBranches.map((branch) => [branch.name, branch]));
	for (const branch of remoteBranches) if (!byName.has(branch.name)) byName.set(branch.name, branch);
	return [...byName.values()]
		.sort((left, right) => {
			if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
			if (left.updatedAt !== undefined && right.updatedAt !== undefined) return right.updatedAt - left.updatedAt;
			if (left.updatedAt !== undefined) return -1;
			if (right.updatedAt !== undefined) return 1;
			return left.name.localeCompare(right.name);
		})
		.slice(0, limit);
}

function markCurrent(branches: readonly ReferenceBranch[], current: string): ReferenceBranch[] {
	return branches.map((branch) => ({ ...branch, isCurrent: branch.name === current }));
}

function parseLocalBranches(output: string, current: string): ReferenceBranch[] {
	return output
		.split("\n")
		.filter(Boolean)
		.map((line): ReferenceBranch => {
			const [branchName = "", seconds = "0"] = line.split("\0");
			return { name: branchName, updatedAt: Number(seconds) * 1000, isCurrent: branchName === current };
		})
		.filter((branch) => branch.name && branch.name !== "HEAD")
		.sort((left, right) => {
			if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
			return (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || left.name.localeCompare(right.name);
		});
}

function parseRemoteBranchNames(output: string): string[] {
	return output
		.split("\n")
		.map((line) => line.split("\t")[1]?.replace(/^refs\/heads\//, "") ?? "")
		.filter((name) => name && name !== "HEAD");
}

async function switchBranch(git: GitRunner, path: string, branch: string): Promise<void> {
	const local = await git.run(["branch", "--list", branch], { cwd: path, optional: true });
	if (local.trim()) {
		await git.run(["switch", branch], { cwd: path, timeout: BRANCH_SWITCH_TIMEOUT_MS });
		return;
	}

	const remote = await git.run(["show-ref", "--verify", `refs/remotes/origin/${branch}`], {
		cwd: path,
		optional: true,
		timeout: BRANCH_LOOKUP_TIMEOUT_MS,
	});
	if (!remote.trim()) {
		await git.run(["fetch", "--quiet", "--depth=1", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`], {
			cwd: path,
			timeout: BRANCH_SWITCH_TIMEOUT_MS,
		});
	}
	await git.run(["switch", "--track", "-c", branch, `origin/${branch}`], {
		cwd: path,
		timeout: BRANCH_SWITCH_TIMEOUT_MS,
	});
}

function referenceNameFromUrl(url: string): string {
	const name = basename(
		url
			.trim()
			.replace(/[?#].*$/, "")
			.replace(/\/+$/, "")
			.replace(/\.git$/i, ""),
	)
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");

	if (!name || name === "." || name === "..") throw new Error("Could not derive reference folder name from Git URL.");
	return name;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
