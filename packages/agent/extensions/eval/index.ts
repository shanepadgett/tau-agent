import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	defineTool,
	getLanguageFromPath,
	highlightCode,
	keyHint,
	type ExecResult,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BoundedTextResultBuilder } from "../../shared/bounded-text-result.ts";
import { onTauEventImmediately } from "../../shared/events.ts";
import { createScriptSourceStore } from "../../shared/script-source.ts";
import { createTemporaryOutputStore } from "../../shared/temporary-output-store.ts";
import { renderToolOutputPreview } from "../../shared/text.ts";

type Language = "python3" | "node";

interface Runtimes {
	python3: string | undefined;
	node: string | undefined;
}

interface EvalRenderState {
	inputOverflow: boolean;
}

const TIMEOUT_MS = 120_000;

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
	return { python3, node };
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

export default function evalExtension(pi: ExtensionAPI): void {
	const runtimes = detectRuntimes();
	const detected = (["python3", "node"] as const).filter((lang): lang is Language => runtimes[lang] !== undefined);
	if (detected.length === 0) return;

	const langPhrase = detected.map((lang) => (lang === "python3" ? "Python 3" : "Node")).join(" or ");

	const scriptStore = createScriptSourceStore();
	const temporaryOutput = createTemporaryOutputStore();
	onTauEventImmediately(pi, "eval.source-store", "tau:eval.source-store", ({ accept }) => accept(scriptStore));
	pi.on("session_start", async () => {
		await temporaryOutput.shutdown();
		await temporaryOutput.start();
	});

	function resolveCommand(language: Language): string {
		const cmd = runtimes[language];
		if (cmd) return cmd;
		if (language === "python3") throw new Error("Python 3 is not available on this machine.");
		throw new Error("Node unavailable (needs Node >= 22.6 with --experimental-strip-types).");
	}

	async function runScript(
		language: Language,
		command: string,
		source: string,
		cwd: string,
		signal: AbortSignal | undefined,
	): Promise<ExecResult> {
		const dir = await mkdtemp(join(tmpdir(), "tau-eval-"));
		try {
			const file = join(dir, language === "python3" ? "_run.py" : "_run.ts");
			await writeFile(file, source, "utf8");
			const args = language === "python3" ? [file] : ["--experimental-strip-types", file];
			const result = await pi.exec(command, args, { cwd, signal, timeout: TIMEOUT_MS });
			return {
				...result,
				stdout: scrubPath(result.stdout, file, dir),
				stderr: scrubPath(result.stderr, file, dir),
			};
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => {
				// best-effort cleanup
			});
		}
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
	].filter((note): note is string => note !== undefined);

	const tool = defineTool<typeof paramsSchema, undefined, EvalRenderState>({
		name: "eval",
		label: "Eval",
		description: [
			`Run a ${langPhrase} script in the project cwd and return stdout.`,
			"Each call starts a fresh process; variables and imports do not persist.",
			...runtimeNotes,
			"On non-zero exit: result includes scriptId. Retry with same language + scriptId + edits [{oldText,newText}]; do not resend the full script unless the approach is wrong.",
			`Available: ${langPhrase}.`,
		].join("\n"),
		promptSnippet: `Run ${langPhrase} scripts; on failure retry with edits + scriptId.`,
		promptGuidelines: [
			"Use eval for custom Python or Node code, even for one-off tasks. Never pass custom code to these runtimes through bash with -c/-e, a heredoc, a temporary source file, or a wrapper.",
			"Use bash for direct shell commands, focused read-only filtering such as jq, existing project commands, and genuinely shell-specific process orchestration. Do not move custom code into bash to avoid review.",
			"eval never exposes the script path; you already have the source. Never try to read it back.",
		],
		parameters: paramsSchema,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const language = params.language;
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Cancelled." }], details: undefined };
			}
			scriptStore.verifyAndConsume(toolCallId, params);
			const command = resolveCommand(language);
			const resolved = scriptStore.resolve(params);
			const scriptId = resolved.scriptId ?? newScriptId();
			const source = resolved.source;
			scriptStore.remember(scriptId, language, source);
			await onUpdate?.({
				content: [{ type: "text", text: `Running ${languageLabel(language)}...` }],
				details: undefined,
			});
			const result = await runScript(language, command, source, ctx.cwd, signal);
			const succeeded = result.code === 0 && !result.killed;
			const output = new BoundedTextResultBuilder(temporaryOutput, "tail");
			let content: string;
			try {
				await output.append(succeeded ? result.stdout.trim() : result.stderr.trim() || result.stdout.trim());
				if (signal?.aborted) {
					await output.abort();
					return { content: [{ type: "text", text: "Cancelled." }], details: undefined };
				}
				content = (await output.finish()).content;
			} catch (error) {
				await output.abort();
				throw error;
			}
			if (succeeded) {
				scriptStore.forget(scriptId);
				return { content: [{ type: "text", text: content.trim() || "(no output)" }], details: undefined };
			}
			throw new Error(`${content ? `${content}\n\n` : ""}scriptId: ${scriptId}`);
		},
		renderCall(args, theme, context) {
			context.state.inputOverflow = false;
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			let header = theme.fg("toolTitle", theme.bold("eval"));
			if (typeof args.language === "string") {
				header += ` ${theme.fg("muted", languageLabel(args.language))}`;
			}
			const edits = Array.isArray(args.edits) ? args.edits : [];
			const lines = (
				edits.length > 0
					? edits.flatMap((edit) => [
							...(typeof edit?.oldText === "string"
								? edit.oldText.split("\n").map((line) => theme.fg("error", `- ${line}`))
								: []),
							...(typeof edit?.newText === "string"
								? edit.newText.split("\n").map((line) => theme.fg("success", `+ ${line}`))
								: []),
						])
					: typeof args.script === "string"
						? args.script.split("\n")
						: []
			).map((line) => line.replace(/\r/g, "").replace(/\t/g, "   "));
			while (lines.at(-1) === "") lines.pop();
			if (lines.length === 0) {
				text.setText(header);
				return text;
			}
			const displayLines = context.expanded ? lines : lines.slice(0, 10);
			const language =
				args.language === "python3"
					? getLanguageFromPath("_run.py")
					: args.language === "node"
						? getLanguageFromPath("_run.ts")
						: undefined;
			const body =
				edits.length > 0
					? displayLines.join("\n")
					: language
						? highlightCode(displayLines.join("\n"), language).join("\n")
						: displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
			const remaining = lines.length - displayLines.length;
			context.state.inputOverflow = remaining > 0;
			let output = body ? `${header}\n\n${body}` : header;
			if (remaining > 0) {
				output += theme.fg("muted", `\n... (${remaining} more lines, ${lines.length} total`);
				if (context.isPartial) {
					output += theme.fg("muted", ", ") + keyHint("app.tools.expand", "to expand");
				}
				output += theme.fg("muted", ")");
			}
			text.setText(output);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (options.isPartial) {
				text.setText("");
				return text;
			}
			const output = result.content
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			const divider = theme.fg("muted", context.isError ? "── Error ──" : "── Output ──");
			const preview = renderToolOutputPreview(output, options.expanded || context.isError, theme);
			const expandHint =
				!options.expanded && context.state.inputOverflow && !preview.truncated
					? `\n${keyHint("app.tools.expand", "to expand")}`
					: "";
			text.setText(`\n${divider}\n\n${preview.text}${expandHint}`);
			return text;
		},
	});

	pi.registerTool(tool);

	pi.on("session_shutdown", async () => {
		scriptStore.clear();
		await temporaryOutput.shutdown();
	});
}
