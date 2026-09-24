import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExecResult, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BoundedTextResultBuilder } from "../../shared/bounded-text-result.ts";
import { onTauEventImmediately } from "../../shared/events.ts";
import { createScriptSourceStore } from "../../shared/script-source.ts";
import { createTemporaryOutputStore } from "../../shared/temporary-output-store.ts";
import { renderToolOutputPreview } from "../../shared/text.ts";

type Language = "python3" | "node" | "deno";

interface Runtimes {
	python3: string | undefined;
	node: string | undefined;
	deno: string | undefined;
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

	const scriptStore = createScriptSourceStore();
	const temporaryOutput = createTemporaryOutputStore();
	onTauEventImmediately(pi, "script-runner.source-store", "tau:script-runner.source-store", ({ accept }) =>
		accept(scriptStore),
	);
	pi.on("session_start", async () => {
		await temporaryOutput.shutdown();
		await temporaryOutput.start();
	});

	function resolveCommand(language: Language): string {
		const cmd = runtimes[language];
		if (cmd) return cmd;
		if (language === "python3") throw new Error("Python 3 is not available on this machine.");
		if (language === "node") {
			throw new Error("Node unavailable (needs Node >= 22.6 with --experimental-strip-types).");
		}
		throw new Error("Deno is not available on this machine.");
	}

	async function runScript(
		language: Language,
		command: string,
		source: string,
		cwd: string,
		signal: AbortSignal | undefined,
	): Promise<ExecResult> {
		const dir = await mkdtemp(join(tmpdir(), "tau-script-runner-"));
		try {
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
			text.setText(renderToolOutputPreview(output, options.expanded || context.isError, theme));
			return text;
		},
	});

	pi.registerTool(tool);

	pi.on("session_shutdown", async () => {
		scriptStore.clear();
		await temporaryOutput.shutdown();
	});
}
