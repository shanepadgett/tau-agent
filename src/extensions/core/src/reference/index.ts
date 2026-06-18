import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const REFERENCES_DIR = join(homedir(), ".local", "share", "tau-agent", "references");
const CLONE_TIMEOUT_MS = 300_000;
const UPDATE_TIMEOUT_MS = 120_000;

interface ReferenceItem {
	name: string;
	path: string;
}

type ReferencePanelAction =
	| { action: "cancel" }
	| { action: "new" }
	| { action: "update" }
	| { action: "submit"; selected: ReferenceItem[] };

export function registerReference(pi: ExtensionAPI): void {
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
				if (url) {
					await cloneReference(pi, ctx, url);
				} else {
					await promptAndCloneReference(pi, ctx);
				}
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

			await openReferencePanel(pi, ctx);
		},
	});
}

async function openReferencePanel(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	let references = await loadReferences();

	while (true) {
		const result = await showReferencePanel(ctx, references);

		if (result.action === "cancel") return;

		if (result.action === "new") {
			await promptAndCloneReference(pi, ctx);
			references = await loadReferences();
			continue;
		}

		if (result.action === "update") {
			await updateReferences(pi, ctx, references);
			references = await loadReferences();
			continue;
		}

		await sendReferencePrompt(pi, ctx, result.selected);
		return;
	}
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
					for (const [index, item] of references.entries()) {
						const active = index === cursor;
						const pointer = active ? theme.fg("accent", "> ") : "  ";
						const box = selected.has(item.path) ? "[x]" : "[ ]";
						const label = active ? theme.fg("accent", item.name) : theme.fg("text", item.name);
						lines.push(truncateToWidth(`${pointer}${box} ${label}`, renderWidth));
					}
				}

				lines.push("");
				lines.push(
					...wrapTextWithAnsi(
						theme.fg("dim", "↑↓ move • space toggle • enter prompt • n new • u update • esc cancel"),
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

async function sendReferencePrompt(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	references: readonly ReferenceItem[],
): Promise<void> {
	const prompt = await ctx.ui.editor("Reference prompt", "");
	if (!prompt?.trim()) {
		ctx.ui.notify("Reference prompt cancelled.", "info");
		return;
	}

	const message = buildReferencePrompt(references, prompt);
	if (ctx.isIdle()) {
		pi.sendUserMessage(message);
	} else {
		pi.sendUserMessage(message, { deliverAs: "followUp" });
	}
}

function buildReferencePrompt(references: readonly ReferenceItem[], prompt: string): string {
	return [
		"Use these local reference repositories when relevant to this request. Treat them as read-only examples unless explicitly asked otherwise.",
		"",
		"<references>",
		...references.map((ref) => `- ${ref.name}: ${ref.path}`),
		"</references>",
		"",
		"<request>",
		prompt.trim(),
		"</request>",
	].join("\n");
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

	await cloneReference(pi, ctx, url);
}

async function cloneReference(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawUrl: string): Promise<void> {
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

	ctx.ui.setStatus("reference", `adding ${name}`);
	try {
		const result = await pi.exec("git", ["clone", url, target], {
			cwd: root,
			signal: ctx.signal,
			timeout: CLONE_TIMEOUT_MS,
		});
		if (result.code !== 0) throw new Error(execDetails(result));

		ctx.ui.notify(`Added ${name} to ${target}`, "info");
	} catch (error) {
		ctx.ui.notify(`New reference failed: ${errorText(error)}`, "error");
	} finally {
		ctx.ui.setStatus("reference", undefined);
	}
}

async function loadReferences(): Promise<ReferenceItem[]> {
	const root = referenceRoot();
	await mkdir(root, { recursive: true });

	return (await readdir(root, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => ({ name: entry.name, path: join(root, entry.name) }))
		.sort((left, right) => left.name.localeCompare(right.name));
}

async function updateReferences(
	pi: ExtensionAPI,
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
			const result = await pi.exec("git", ["pull", "--ff-only", "--quiet"], {
				cwd: ref.path,
				signal: ctx.signal,
				timeout: UPDATE_TIMEOUT_MS,
			});
			if (result.code === 0) {
				updated.push(ref.path);
			} else {
				failures.push(`${ref.name}: ${execDetails(result)}`);
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

function execDetails(result: { stdout: string; stderr: string; code: number }): string {
	return [result.stderr, result.stdout].filter(Boolean).join("\n").trim() || `exit code ${result.code}`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
