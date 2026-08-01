import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	type ExecResult,
	type ExtensionAPI,
	type Theme,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Language = "python3" | "node" | "deno";

interface Runtimes {
	python3: string | undefined;
	node: string | undefined;
	deno: string | undefined;
}

interface StoredScript {
	language: Language;
	source: string;
}

const TIMEOUT_MS = 120_000;
const MAX_STORED = 8;

function detectRuntimes(): Runtimes {
	let python3: string | undefined;
	try {
		execFileSync("python3", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
		python3 = "python3";
	} catch {
		// runtime not installed
	}
	const [major, minor] = process.versions.node.split(".").map(Number);
	let node: string | undefined;
	if (major > 22 || (major === 22 && minor >= 6)) {
		node = process.execPath;
	}
	let deno: string | undefined;
	try {
		execFileSync("deno", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
		deno = "deno";
	} catch {
		// runtime not installed
	}
	return { python3, node, deno };
}

function capitalize(lang: Language): string {
	if (lang === "python3") return "Python 3";
	if (lang === "node") return "Node";
	return "Deno";
}

function formatLangList(langs: readonly Language[]): string {
	const names = langs.map(capitalize);
	if (names.length <= 2) return names.join(" or ");
	return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

function languageLabel(lang: string): string {
	return lang === "node" ? "node (Node.js)" : lang;
}

function newScriptId(): string {
	return randomBytes(5).toString("base64url").slice(0, 7);
}

function scrubPath(text: string, file: string, dir: string): string {
	if (!text) return text;
	return text.replaceAll(file, "<script>").replaceAll(dir, "<tmpdir>");
}

function applyEdits(source: string, edits: ReadonlyArray<{ oldText: string; newText: string }>): string {
	let next = source;
	for (const edit of edits) {
		const idx = next.indexOf(edit.oldText);
		if (idx === -1) {
			throw new Error("edits oldText not found. Copy exact text from the script you wrote.");
		}
		next = next.slice(0, idx) + edit.newText + next.slice(idx + edit.oldText.length);
	}
	return next;
}

function renderEditsPreview(edits: ReadonlyArray<{ oldText: string; newText: string }>, theme: Theme): string {
	return edits
		.map((edit) => {
			const oldLines = edit.oldText
				.split("\n")
				.map((line) => theme.fg("error", `- ${line}`))
				.join("\n");
			const newLines = edit.newText
				.split("\n")
				.map((line) => theme.fg("success", `+ ${line}`))
				.join("\n");
			return `${oldLines}\n${newLines}`;
		})
		.join("\n");
}

export default function scriptRunnerExtension(pi: ExtensionAPI): void {
	const runtimes = detectRuntimes();
	const detected = (["python3", "node", "deno"] as const).filter(
		(lang): lang is Language => runtimes[lang] !== undefined,
	);
	if (detected.length === 0) return;

	const langPhrase = formatLangList(detected);

	const scripts = new Map<string, StoredScript>();
	let tempDir: string | undefined;

	function remember(scriptId: string, script: StoredScript): void {
		scripts.set(scriptId, script);
		while (scripts.size > MAX_STORED) {
			const oldest = scripts.keys().next().value;
			if (oldest === undefined) break;
			scripts.delete(oldest);
		}
	}

	function resolveCommand(language: Language): string {
		const cmd = runtimes[language];
		if (cmd) return cmd;
		if (language === "python3") throw new Error("Python 3 is not available on this machine.");
		if (language === "node") {
			throw new Error("Node unavailable (needs Node >= 22.6 with --experimental-strip-types).");
		}
		throw new Error("Deno is not available on this machine.");
	}

	async function ensureTempDir(): Promise<string> {
		if (tempDir) return tempDir;
		tempDir = await mkdtemp(join(tmpdir(), "tau-script-runner-"));
		return tempDir;
	}

	async function runScript(
		language: Language,
		command: string,
		source: string,
		cwd: string,
		signal: AbortSignal | undefined,
	): Promise<ExecResult> {
		const dir = await ensureTempDir();
		const file = join(dir, language === "python3" ? "_run.py" : "_run.ts");
		await writeFile(file, source, "utf8");
		const args =
			language === "python3"
				? [file]
				: language === "node"
					? ["--experimental-strip-types", file]
					: ["run", "-A", file];
		const result = await pi.exec(command, args, { cwd, signal, timeout: TIMEOUT_MS });
		return {
			...result,
			stdout: scrubPath(result.stdout, file, dir),
			stderr: scrubPath(result.stderr, file, dir),
		};
	}

	const paramsSchema = Type.Object(
		{
			language: StringEnum(detected, {
				description: "Execution runtime.",
			}),
			script: Type.Optional(
				Type.String({ description: "Full source for a new run. Omit when retrying with edits." }),
			),
			scriptId: Type.Optional(Type.String({ description: "From a failed run. Required with edits." })),
			edits: Type.Optional(
				Type.Array(
					Type.Object({
						oldText: Type.String({ description: "Exact text currently in the script." }),
						newText: Type.String({ description: "Replacement text." }),
					}),
					{
						description: "Patches applied to the stored script before rerun.",
					},
				),
			),
		},
		{ additionalProperties: false },
	);

	const runtimeNotes = [
		detected.includes("node")
			? "language=node: local Node.js via node --experimental-strip-types (not tsc/ts-node)."
			: undefined,
		detected.includes("deno") ? "language=deno: local Deno via deno run -A." : undefined,
	].filter((note): note is string => note !== undefined);

	const tool = defineTool<typeof paramsSchema, undefined>({
		name: "script_runner",
		label: "Script Runner",
		description: [
			`Run a ${langPhrase} script in the project cwd and return stdout.`,
			...runtimeNotes,
			"On non-zero exit: result includes scriptId. Retry with same language + scriptId + edits [{oldText,newText}]; do not resend the full script unless the approach is wrong.",
			`Available: ${langPhrase}.`,
		].join("\n"),
		promptSnippet: `Run ${langPhrase} scripts; on failure retry with edits + scriptId.`,
		promptGuidelines: [
			`Prefer script_runner over bash for ${langPhrase} when computation, data handling, or bulk file work is cleaner than chaining tools.`,
			"script_runner never exposes the script path; you already have the source. Never try to read it back.",
		],
		parameters: paramsSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const language = params.language;
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Cancelled." }], details: undefined };
			}

			const command = resolveCommand(language);
			const edits = params.edits;
			let scriptId: string | undefined = params.scriptId;
			let source: string;

			if (edits && edits.length > 0) {
				if (!scriptId) throw new Error("edits require scriptId from the failed run.");
				const stored = scripts.get(scriptId);
				if (!stored) {
					throw new Error(`No stored script for scriptId ${scriptId}. Evicted; resend full script.`);
				}
				if (stored.language !== language) {
					throw new Error(`Language mismatch: scriptId ${scriptId} is ${stored.language}, not ${language}.`);
				}
				source = applyEdits(stored.source, edits);
			} else {
				if (typeof params.script !== "string" || params.script.length === 0) {
					throw new Error("Provide script, or edits + scriptId.");
				}
				source = params.script;
				if (!scriptId) scriptId = newScriptId();
			}

			remember(scriptId, { language, source });
			await onUpdate?.({
				content: [{ type: "text", text: `Running ${languageLabel(language)}...` }],
				details: undefined,
			});

			const result = await runScript(language, command, source, ctx.cwd, signal);
			if (result.code === 0 && !result.killed) {
				scripts.delete(scriptId);
				const trunc = truncateTail(result.stdout.trim(), {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});
				const out = trunc.content.trim();
				const note = trunc.truncated
					? `\n\n[output truncated: kept tail ${trunc.outputLines} / ${trunc.totalLines} lines]`
					: "";
				return {
					content: [{ type: "text", text: out ? `${out}${note}` : `(no output)${note}` }],
					details: undefined,
				};
			}

			const diag = result.stderr.trim() || result.stdout.trim();
			const trunc = truncateTail(diag, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const note = trunc.truncated
				? `\n\n[output truncated: kept tail ${trunc.outputLines} / ${trunc.totalLines} lines]`
				: "";
			const detail = trunc.content ? `${trunc.content}${note}\n\n` : "";
			throw new Error(`${detail}scriptId: ${scriptId}`);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const header = `${theme.fg("toolTitle", theme.bold("script_runner"))} ${theme.fg("muted", languageLabel(args.language))}`;
			const edits = args.edits;
			const body =
				edits && edits.length > 0
					? renderEditsPreview(edits, theme)
					: theme.fg("accent", theme.bold(args.script ?? ""));
			text.setText(body ? `${header}\n${body}` : header);
			return text;
		},
	});

	pi.registerTool(tool);

	pi.on("session_shutdown", () => {
		scripts.clear();
		const dir = tempDir;
		tempDir = undefined;
		if (dir) {
			void rm(dir, { recursive: true, force: true }).catch(() => {
				// best-effort cleanup
			});
		}
	});
}
