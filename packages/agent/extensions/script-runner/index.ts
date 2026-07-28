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

type Language = "python" | "typescript";

interface Runtimes {
	python: string | undefined;
	typescript: string | undefined;
}

interface StoredScript {
	language: Language;
	source: string;
}

const TIMEOUT_MS = 120_000;
const MAX_STORED = 8;

function detectRuntimes(): Runtimes {
	let python: string | undefined;
	for (const cmd of ["python3", "python"] as const) {
		try {
			execFileSync(cmd, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
			python = cmd;
			break;
		} catch {
			// runtime not installed
		}
	}
	const [major, minor] = process.versions.node.split(".").map(Number);
	let typescript: string | undefined;
	if (major > 22 || (major === 22 && minor >= 6)) {
		typescript = process.execPath;
	}
	return { python, typescript };
}

function capitalize(lang: Language): string {
	return lang === "python" ? "Python" : "TypeScript";
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
			throw new Error(
				"An edits oldText was not found in the script. Copy the exact text from the script you wrote.",
			);
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
	const detected = (["python", "typescript"] as const).filter(
		(lang): lang is Language => (lang === "python" ? runtimes.python : runtimes.typescript) !== undefined,
	);
	if (detected.length === 0) return;

	const langPhrase = detected.map(capitalize).join(" or ");

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
		if (language === "python") {
			const cmd = runtimes.python;
			if (!cmd) throw new Error("Python is not available on this machine.");
			return cmd;
		}
		const cmd = runtimes.typescript;
		if (!cmd) throw new Error("TypeScript is not available (requires Node >= 22.6).");
		return cmd;
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
		const file = join(dir, language === "python" ? "_run.py" : "_run.ts");
		await writeFile(file, source, "utf8");
		const args = language === "python" ? [file] : ["--experimental-strip-types", file];
		const result = await pi.exec(command, args, { cwd, signal, timeout: TIMEOUT_MS });
		return {
			...result,
			stdout: scrubPath(result.stdout, file, dir),
			stderr: scrubPath(result.stderr, file, dir),
		};
	}

	const paramsSchema = Type.Object(
		{
			language: StringEnum(detected, { description: "Execution language available on this machine." }),
			script: Type.Optional(
				Type.String({ description: "Full script source for a new run. Omit when retrying with edits." }),
			),
			scriptId: Type.Optional(
				Type.String({ description: "scriptId returned by a failed run. Required when retrying with edits." }),
			),
			edits: Type.Optional(
				Type.Array(
					Type.Object({
						oldText: Type.String({ description: "Exact text currently in the script." }),
						newText: Type.String({ description: "Replacement text." }),
					}),
					{
						description:
							"Targeted oldText/newText patches applied to the stored script before rerun. Prefer this over resending the whole script.",
					},
				),
			),
		},
		{ additionalProperties: false },
	);

	const tool = defineTool<typeof paramsSchema, undefined>({
		name: "script_runner",
		label: "Script Runner",
		description: `Run a ${langPhrase} script in the project working directory and return its output. On a non-zero exit, returns a scriptId; retry by sending targeted {oldText,newText} edits against the script you already wrote (same language + scriptId) instead of resending the whole script. Available on this machine: ${langPhrase}.`,
		promptSnippet: `Run ${langPhrase} scripts; fix failures with targeted edits instead of rewriting the whole script.`,
		promptGuidelines: [
			`Prefer script_runner over bash for ${langPhrase} when computation, data handling, or bulk file work is cleaner than chaining built-in tools.`,
			`When script_runner fails, do not resend the full script. Call script_runner again with the same language, the returned scriptId, and an edits array of {oldText,newText} patches against the script you just wrote. Only resend a full script if the approach itself was wrong.`,
			`script_runner never exposes the script file path, and you already know the script you sent. Never try to read it back.`,
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
				if (!scriptId) throw new Error("edits require the scriptId returned by the failed run.");
				const stored = scripts.get(scriptId);
				if (!stored) {
					throw new Error(
						`No stored script for scriptId ${scriptId}. It may have been evicted; resend the full script.`,
					);
				}
				if (stored.language !== language) {
					throw new Error(`Language mismatch: scriptId ${scriptId} is ${stored.language}, not ${language}.`);
				}
				source = applyEdits(stored.source, edits);
			} else {
				if (typeof params.script !== "string" || params.script.length === 0) {
					throw new Error("Provide a script for a new run, or edits + scriptId to retry.");
				}
				source = params.script;
				if (!scriptId) scriptId = newScriptId();
			}

			remember(scriptId, { language, source });
			await onUpdate?.({ content: [{ type: "text", text: `Running ${language}...` }], details: undefined });

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
			throw new Error(
				`${detail}scriptId: ${scriptId}\nRetry with edits: [{oldText,newText}] using the same language and scriptId; do not resend the full script.`,
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const header = `${theme.fg("toolTitle", theme.bold("script_runner"))} ${theme.fg("muted", args.language)}`;
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
