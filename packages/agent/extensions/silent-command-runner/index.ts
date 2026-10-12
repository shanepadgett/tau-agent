import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
	defineTool,
	keyText,
	type ExecResult,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BoundedTextResultBuilder, type BoundedTextOverflowDetails } from "../../shared/bounded-text-result.ts";
import { onTauEvent } from "../../shared/events.ts";
import { createTemporaryOutputStore } from "../../shared/temporary-output-store.ts";
import { registerPromptSource } from "../../shared/prompt-contributions.ts";
import { createFileScope, type FileScope } from "../../shared/glob.ts";
import { isModifyingTool, walkFiles } from "../../shared/project-files.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { resolveProjectRoot } from "../../shared/settings/paths.ts";
import silentCommandRunnerSettings from "./settings.ts";

const MESSAGE_TYPE = "tau:silent-command-runner";
const CHECK_WIDGET_KEY = "tau:silent-command-runner:checks";
const checkParams = Type.Object({}, { additionalProperties: false });
const DEFAULT_MAX_OUTPUT_BYTES = 51200;
const DEFAULT_TIMEOUT_MS = 120000;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_EXCLUDE_GLOBS = [
	".git/**",
	"node_modules/**",
	"dist/**",
	"build/**",
	"coverage/**",
	".cache/**",
	".next/**",
	".turbo/**",
	".parcel-cache/**",
	"out/**",
];

interface CommandConfig {
	name: string;
	command: string;
	cwd: string;
	env: Record<string, string>;
	details: string | undefined;
	includeGlobs: string[];
	excludeGlobs: string[];
	scope: FileScope;
	timeoutMs: number;
}

interface Settings {
	maxOutputBytes: number;
	afterWrite: CommandConfig[];
	afterRun: CommandConfig[];
	beforeCommit: CommandConfig[];
}

type Snapshot = Map<string, string>;

interface WriteSnapshot {
	projectRoot: string;
	files: Snapshot;
}

interface OutputTail {
	content: string;
	truncated: boolean;
}

interface FailedCommandDetails {
	name: string;
	command: string;
	cwd: string;
	envKeys: string[];
	code: number;
	killed: boolean;
	durationMs: number;
	stdout: OutputTail;
	stderr: OutputTail;
}

interface FailureDetails {
	failed: FailedCommandDetails[];
}

interface CheckDetails extends FailureDetails {
	passed: string[];
	overflow: BoundedTextOverflowDetails;
}

export default function silentCommandRunnerExtension(pi: ExtensionAPI): void {
	let settings: Settings = normalizeSettings(silentCommandRunnerSettings.defaults);
	let runBaseline: Snapshot = new Map();
	const changedPaths = new Set<string>();
	let abortController: AbortController | undefined;
	let sessionActive = false;
	let runActive = false;
	let writeRevision = 0;
	let checkedRevision: number | undefined;
	const pendingFailedNames = new Set<string>();
	const temporaryOutput = createTemporaryOutputStore();
	const snapshots = new Map<string, WriteSnapshot>();
	const fixedHashes: Snapshot = new Map();
	const fixerControllers = new Set<AbortController>();
	let fixerQueue: Promise<void> = Promise.resolve();
	let checkToolRegistered = false;

	let checkTool = defineTool<typeof checkParams, CheckDetails | { progress: string } | undefined>({
		name: "checks",
		label: "Repository Checks",
		description: formatCheckInstructions(settings.afterRun),
		parameters: checkParams,
		exposure: "hidden",
		executionMode: "sequential",
		annotations: { readOnlyHint: true },
		async execute(toolCallId, _params, signal, onUpdate, ctx) {
			// Pi shows nested calls in their parent's row, without rendering their partial results.
			if (toolCallId.includes("/")) return await runChecksWithWidget(ctx, signal);
			return await runChangedCommands(
				ctx.cwd,
				(progress) => onUpdate?.({ content: [], details: { progress } }),
				signal,
			);
		},
		renderCall(_args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold("Repository checks")));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			const output =
				options.isPartial && result.details && "progress" in result.details
					? result.details.progress
					: result.content
							.filter((item) => item.type === "text")
							.map((item) => item.text)
							.join("\n");
			text.setText(theme.fg(context.isError ? "error" : "muted", output));
			return text;
		},
	});
	pi.registerMessageRenderer<FailureDetails>(MESSAGE_TYPE, (message, { expanded }, theme) =>
		renderFailure(asFailureDetails(message.details), expanded, theme),
	);

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWidget(CHECK_WIDGET_KEY, undefined);
		await refreshSettings(ctx);
		await temporaryOutput.shutdown();
		await temporaryOutput.start();
		sessionActive = true;
		runActive = false;
		writeRevision = 0;
		checkedRevision = 0;
		pendingFailedNames.clear();
		runBaseline = new Map();
		changedPaths.clear();
		snapshots.clear();
		fixedHashes.clear();
	});

	registerPromptSource(pi, {
		key: "checks/instructions",
		section: "automatic-checks",
		refresh: "append",
		async read(ctx) {
			await refreshSettings(ctx);
			const instructions: string[] = [];
			if (settings.afterWrite.length)
				instructions.push(
					`Configured fixes run automatically after modifying tools finish; do not run them manually or claim checks passed from them: ${formatCommandNames(settings.afterWrite)}.`,
				);
			if (settings.afterRun.length) instructions.push(formatCheckInstructions(settings.afterRun));
			return instructions.join("\n\n");
		},
	});

	pi.on("agent_start", async (_event, ctx) => {
		// Pi emits agent_start again for continuations inside the same unsettled run.
		if (runActive) return;
		runActive = true;
		await fixerQueue;
		snapshots.clear();
		fixedHashes.clear();
		writeRevision = 0;
		checkedRevision = 0;
		pendingFailedNames.clear();
		changedPaths.clear();
		runBaseline = await snapshotFiles(await resolveProjectRoot(ctx.cwd), settings.afterRun, ctx.signal);
	});

	pi.on("agent_settled", () => {
		runActive = false;
	});

	// Uses settings loaded at session start or the last prompt: waitFor must be called before any await.
	onTauEvent(pi, "silent-command-runner.before-commit", "tau:commit.before", (event) => {
		if (!sessionActive || settings.beforeCommit.length === 0) return;
		event.waitFor("silent-command-runner", runBeforeCommit(event.cwd, settings.beforeCommit, event.signal));
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!sessionActive) return;
		if (event.toolName === "checks") {
			const ancestor = [...snapshots].find(([id]) => event.toolCallId.startsWith(`${id}/`));
			if (ancestor) await flushFixes(ancestor[1], ctx);
			return;
		}
		const tool = pi.getAllTools().find((entry) => entry.name === event.toolName);
		if (!isModifyingTool(event.toolName, tool?.annotations?.readOnlyHint)) return;
		writeRevision += 1;
		// Descendant writes share the outer fixer snapshot, but invalidate verification individually.
		if ([...snapshots.keys()].some((id) => event.toolCallId.startsWith(`${id}/`))) return;
		if (settings.afterWrite.length === 0 && settings.afterRun.length === 0) return;
		await fixerQueue;
		if (!sessionActive) return;
		const projectRoot = await resolveProjectRoot(ctx.cwd);
		snapshots.set(event.toolCallId, {
			projectRoot,
			files: await snapshotFiles(projectRoot, [...settings.afterWrite, ...settings.afterRun], ctx.signal),
		});
	});

	pi.on("tool_result", async (event, ctx) => {
		const snapshot = snapshots.get(event.toolCallId);
		if (!snapshot) return;
		// Keep the snapshot registered until processing completes so descendants stay grouped.
		try {
			await flushFixes(snapshot, ctx);
		} catch (error) {
			if (sessionActive && !ctx.signal?.aborted)
				ctx.ui.notify(`silent-command-runner: ${errorMessage(error)}`, "error");
		} finally {
			snapshots.delete(event.toolCallId);
		}
	});

	// The last boundary before the run settles: failures continue the run instead of starting a new one.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (
			event.outcome !== "completed" ||
			(checkedRevision === writeRevision && pendingFailedNames.size === 0) ||
			settings.afterRun.length === 0
		)
			return undefined;
		try {
			const result = await runChecksWithWidget(ctx, ctx.signal);
			if (result.details.passed.length > 0)
				ctx.ui.notify(`The following checks passed: ${result.details.passed.join(", ")}`, "info");
			if (result.details.failed.length === 0) return undefined;
			return {
				entries: [
					...event.entries,
					{
						type: "custom_message" as const,
						customType: MESSAGE_TYPE,
						content: result.content,
						display: true,
						details: result.details,
					},
				],
				continue: true,
			};
		} catch (error: unknown) {
			ctx.ui.notify(`silent-command-runner: ${errorMessage(error)}`, "error");
			return undefined;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionActive = false;
		ctx.ui.setWidget(CHECK_WIDGET_KEY, undefined);
		runActive = false;
		abortController?.abort();
		abortController = undefined;
		runBaseline = new Map();
		changedPaths.clear();
		for (const controller of fixerControllers) controller.abort();
		snapshots.clear();
		fixedHashes.clear();
		await temporaryOutput.shutdown();
	});

	async function flushFixes(snapshot: WriteSnapshot, ctx: ExtensionContext): Promise<void> {
		const task = fixerQueue.then(async () => {
			if (!sessionActive || ctx.signal?.aborted) return;
			const commands = [...settings.afterWrite, ...settings.afterRun];
			const current = await snapshotFiles(snapshot.projectRoot, commands, ctx.signal);
			recordChanges(snapshot.files, current, changedPaths);
			const changed = [...current]
				.filter(
					([path, hash]) =>
						hash !== snapshot.files.get(path) &&
						hash !== fixedHashes.get(path) &&
						settings.afterWrite.some((command) => command.scope.matches(path)),
				)
				.map(([path]) => path);
			if (changed.length === 0) {
				snapshot.files = current;
				return;
			}
			const controller = new AbortController();
			fixerControllers.add(controller);
			const cancel = () => controller.abort();
			ctx.signal?.addEventListener("abort", cancel, { once: true });
			if (ctx.signal?.aborted) controller.abort();
			try {
				for (const command of settings.afterWrite) {
					if (!sessionActive || controller.signal.aborted) return;
					const files = changed.filter((path) => command.scope.matches(path));
					if (files.length === 0) continue;
					try {
						await runCommand(
							pi,
							snapshot.projectRoot,
							command,
							controller.signal,
							files.map((path) => resolve(snapshot.projectRoot, path)),
						);
					} catch {
						// Final checks own failure reporting; a failed fixer must not stop the next one.
					}
				}
				const after = await snapshotFiles(snapshot.projectRoot, commands, controller.signal);
				recordChanges(current, after, changedPaths);
				for (const path of changed) {
					const hash = after.get(path);
					if (hash === undefined) fixedHashes.delete(path);
					else fixedHashes.set(path, hash);
				}
				snapshot.files = after;
			} finally {
				ctx.signal?.removeEventListener("abort", cancel);
				fixerControllers.delete(controller);
			}
		});
		// Callers handle failures; the queue must remain usable for subsequent tools.
		fixerQueue = task.catch(() => {});
		await task;
	}

	async function runBeforeCommit(
		cwd: string,
		commands: readonly CommandConfig[],
		signal: AbortSignal,
	): Promise<{ passed: boolean; text: string }> {
		const output = new BoundedTextResultBuilder(temporaryOutput, "tail");
		try {
			const projectRoot = await resolveProjectRoot(cwd);
			const failed: string[] = [];
			for (const command of commands) {
				signal.throwIfAborted();
				const result = await runCommand(pi, projectRoot, command, signal, []);
				if (result.code === 0 && !result.killed) continue;
				failed.push(command.name);
				await output.append(`${formatAgentFailure(result)}\n\n`);
			}
			signal.throwIfAborted();
			if (failed.length > 0) await output.append(`The following checks failed: ${failed.join(", ")}`);
			const result = await output.finish();
			return { passed: failed.length === 0, text: result.content };
		} catch (error) {
			await output.abort();
			throw error;
		}
	}

	async function refreshSettings(ctx: ExtensionContext): Promise<void> {
		const next = normalizeSettings(await loadTauExtensionSettings(ctx, silentCommandRunnerSettings));
		if (JSON.stringify(next.afterRun) !== JSON.stringify(settings.afterRun)) checkedRevision = undefined;
		settings = next;
		const description = formatCheckInstructions(settings.afterRun);
		const exposure = settings.afterRun.length ? "direct" : "hidden";
		if (
			(settings.afterRun.length > 0 || checkToolRegistered) &&
			(!checkToolRegistered || checkTool.description !== description || checkTool.exposure !== exposure)
		) {
			checkTool = { ...checkTool, description, exposure };
			pi.registerTool(checkTool);
			checkToolRegistered = true;
		}
	}

	async function runChecksWithWidget(ctx: ExtensionContext, signal: AbortSignal | undefined) {
		try {
			return await runChangedCommands(
				ctx.cwd,
				(progress) => {
					ctx.ui.setWidget(
						CHECK_WIDGET_KEY,
						(_tui, theme) => new Text(theme.fg("muted", `Repository checks: ${progress}`), 0, 0),
					);
				},
				signal,
			);
		} finally {
			ctx.ui.setWidget(CHECK_WIDGET_KEY, undefined);
		}
	}

	async function runChangedCommands(
		cwd: string,
		reportProgress: (progress: string) => void,
		signal: AbortSignal | undefined,
	): Promise<{ content: { type: "text"; text: string }[]; details: CheckDetails; isError: boolean }> {
		const controller = new AbortController();
		const cancel = () => controller.abort();
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted || !sessionActive) controller.abort();
		abortController = controller;
		const output = new BoundedTextResultBuilder(temporaryOutput, "tail");
		try {
			controller.signal.throwIfAborted();
			await fixerQueue;
			controller.signal.throwIfAborted();
			const revision = writeRevision;
			const projectRoot = await resolveProjectRoot(cwd);
			const current = await snapshotFiles(projectRoot, settings.afterRun, controller.signal);
			recordChanges(runBaseline, current, changedPaths);
			const selected = settings.afterRun.filter(
				(command) =>
					[...changedPaths].some((path) => command.scope.matches(path)) || pendingFailedNames.has(command.name),
			);
			const failed: FailedCommandDetails[] = [];
			const passed: string[] = [];
			for (const command of selected) {
				controller.signal.throwIfAborted();
				reportProgress(`Running ${command.name} · ${passed.length + failed.length + 1}/${selected.length}`);
				const result = await runCommand(pi, projectRoot, command, controller.signal, []);
				controller.signal.throwIfAborted();
				if (result.code !== 0 || result.killed) {
					pendingFailedNames.add(command.name);
					await output.append(`${formatAgentFailure(result)}\n\n`);
					failed.push({
						...result,
						stdout: tailBytes(result.stdout.content, settings.maxOutputBytes),
						stderr: tailBytes(result.stderr.content, settings.maxOutputBytes),
					});
				} else {
					pendingFailedNames.delete(command.name);
					passed.push(command.name);
				}
			}
			if (selected.length === 0) await output.append("No checks apply to the changes in this run.");
			if (passed.length > 0) {
				const summary = `The following checks passed: ${passed.join(", ")}`;
				await output.append(summary);
			}
			if (failed.length > 0) {
				await output.append(
					`${passed.length ? "\n" : ""}The following checks failed: ${failed.map((failure) => failure.name).join(", ")}\nComplete all repairs, then call checks before summarizing the requested work.`,
				);
			}
			controller.signal.throwIfAborted();
			const result = await output.finish();
			if (controller.signal.aborted || writeRevision !== revision) {
				if (result.overflow.temporaryPath) await rm(result.overflow.temporaryPath, { force: true });
				controller.signal.throwIfAborted();
				throw new Error("Files may have changed during checks; call checks again.");
			}
			checkedRevision = revision;
			if (failed.length > 0) {
				runBaseline = current;
				changedPaths.clear();
			}
			return {
				content: [{ type: "text", text: result.content }],
				details: { failed, passed, overflow: result.overflow },
				isError: failed.length > 0,
			};
		} catch (error) {
			await output.abort();
			throw error;
		} finally {
			signal?.removeEventListener("abort", cancel);
			if (abortController === controller) abortController = undefined;
		}
	}
}

function recordChanges(before: Snapshot, after: Snapshot, changed: Set<string>): void {
	for (const path of new Set([...before.keys(), ...after.keys()])) {
		if (before.get(path) !== after.get(path)) changed.add(path);
	}
}

function normalizeSettings(value: typeof silentCommandRunnerSettings.defaults): Settings {
	return {
		maxOutputBytes: positiveInteger(value.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
		afterWrite: normalizeCommands(value.afterWrite),
		afterRun: normalizeCommands(value.afterRun),
		beforeCommit: normalizeCommands(value.beforeCommit),
	};
}

function normalizeCommands(commands: typeof silentCommandRunnerSettings.defaults.afterWrite): CommandConfig[] {
	return commands.flatMap((command) => {
		const name = command.name.trim();
		const commandText = command.command.trim();
		if (!name || !commandText) return [];
		const includeGlobs = nonEmptyStrings(command.includeGlobs, ["**/*"]);
		const excludeGlobs = [...DEFAULT_EXCLUDE_GLOBS, ...nonEmptyStrings(command.excludeGlobs, [])];
		return [
			{
				name,
				command: commandText,
				cwd: command.cwd?.trim() || ".",
				env: command.env ?? {},
				details: command.details?.trim() || undefined,
				includeGlobs,
				excludeGlobs,
				scope: createFileScope(includeGlobs, excludeGlobs),
				timeoutMs: positiveInteger(command.timeoutMs, DEFAULT_TIMEOUT_MS),
			},
		];
	});
}

async function snapshotFiles(
	projectRoot: string,
	commands: readonly CommandConfig[],
	signal: AbortSignal | undefined,
): Promise<Snapshot> {
	const files: Snapshot = new Map();
	for (const path of await walkFiles(
		projectRoot,
		commands.map((command) => command.scope),
		signal,
	)) {
		signal?.throwIfAborted();
		try {
			files.set(
				path,
				createHash("sha256")
					.update(await readFile(resolve(projectRoot, path), { signal }))
					.digest("hex"),
			);
		} catch (error: unknown) {
			if (!isRecord(error) || error.code !== "ENOENT") throw error;
		}
	}
	return files;
}

function formatCheckInstructions(commands: readonly CommandConfig[]): string {
	return [
		"Required repository verification for runs with file edits: Call checks only when you have edited repository files during the current run, including additions, modifications, moves, or deletions. Skip it for discussion, read-only investigation, and in-memory eval or codemode work that does not edit repository files. Calling a write-capable tool alone does not require checks. For runs with file edits, you MUST call checks after all implementation, investigation, builds, and focused testing are complete, immediately before your final summary. Do not send the final summary first or rely on automatic settlement checks to satisfy this requirement. Never use checks for intermediate validation.",
		"Never manually run any repository check listed below or its equivalent, during development or final verification. This includes their task-runner commands, direct binaries, wrappers, and alternate flags through bash, eval, or codemode. Configured formatting, lint, type checking, full test suites, dependency/schema validation, dead-code checks, and duplicate-code checks belong exclusively to checks.",
		"During development, builds and focused tests are allowed only when needed for the work in progress; batch them at meaningful boundaries. The focused-test exception allows a relevant subset of a registered suite, never the full suite. Do not use a build or another command name to bypass the restriction on configured checks.",
		"If checks fail, complete all repairs, then call checks again before your final summary. In a run with file edits, any later write-capable call invalidates the result, even if it changes nothing; finish that work and call checks again. Summarize file-editing work only after verification is current.",
		"You may call it last in the same codemode script as your final edits: await all writes, then text(await tools.checks({})). Pending automatic fixes finish before checks.",
		`Checks: ${commands.length ? commands.map((command) => `${command.name} [${command.command}]${command.details ? `: ${command.details}` : ""}`).join("; ") : "none configured"}`,
	].join("\n");
}

async function runCommand(
	pi: ExtensionAPI,
	projectRoot: string,
	command: CommandConfig,
	signal: AbortSignal,
	files: readonly string[],
): Promise<FailedCommandDetails> {
	const start = Date.now();
	const invalidEnvKey = Object.keys(command.env).find((key) => !ENV_KEY.test(key));
	if (invalidEnvKey) {
		return {
			name: command.name,
			command: command.command,
			cwd: command.cwd,
			envKeys: Object.keys(command.env).sort(),
			code: 1,
			killed: false,
			durationMs: 0,
			stdout: { content: "", truncated: false },
			stderr: { content: `Invalid env key: ${invalidEnvKey}`, truncated: false },
		};
	}

	const cwd = resolve(projectRoot, command.cwd);
	const envArgs = Object.entries(command.env).map(([key, value]) => `${key}=${value}`);
	const shellArgs = ["-lc", command.command.replaceAll("{files}", '"$@"'), "tau-silent-command", ...files];
	let result: ExecResult;
	try {
		result = await pi.exec(
			envArgs.length ? "env" : "sh",
			envArgs.length ? [...envArgs, "sh", ...shellArgs] : shellArgs,
			{
				cwd,
				signal,
				timeout: command.timeoutMs,
			},
		);
	} catch (error) {
		signal.throwIfAborted();
		result = { code: 1, killed: false, stdout: "", stderr: errorMessage(error) };
	}
	return commandDetails(command, cwd, result, Date.now() - start);
}

function formatCommandNames(commands: readonly CommandConfig[]): string {
	return commands.map((command) => command.name).join(", ");
}

function commandDetails(
	command: CommandConfig,
	cwd: string,
	result: ExecResult,
	durationMs: number,
): FailedCommandDetails {
	return {
		name: command.name,
		command: command.command,
		cwd,
		envKeys: Object.keys(command.env).sort(),
		code: result.code,
		killed: result.killed,
		durationMs,
		stdout: { content: result.stdout, truncated: false },
		stderr: { content: result.stderr, truncated: false },
	};
}

function tailBytes(value: string, maxBytes: number): OutputTail {
	const buffer = Buffer.from(value);
	if (buffer.byteLength <= maxBytes) return { content: value, truncated: false };
	return { content: buffer.subarray(buffer.byteLength - maxBytes).toString("utf8"), truncated: true };
}

function formatAgentFailure(failure: FailedCommandDetails): string {
	return [
		`## ${failure.name}`,
		`command: ${failure.command}`,
		`cwd: ${failure.cwd}`,
		`exit: ${failure.killed ? "killed" : failure.code}`,
		formatOutput("stdout", failure.stdout),
		formatOutput("stderr", failure.stderr),
	].join("\n");
}

function formatOutput(label: string, output: OutputTail): string {
	const note = output.truncated ? " (tail, truncated)" : "";
	return `${label}${note}:\n\`\`\`\n${output.content}\n\`\``;
}

function renderFailure(details: FailureDetails, expanded: boolean, theme: Theme): Box {
	const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
	const failed = details.failed;
	const header = `${theme.fg("error", theme.bold("silent-command-runner failed"))}${theme.fg(
		"dim",
		` (${failed.length} command${failed.length === 1 ? "" : "s"}, ${keyText("app.tools.expand")} to ${expanded ? "collapse" : "expand"})`,
	)}`;
	const summary = failed.map(
		(failure) => `- ${failure.name}: ${failure.killed ? "killed" : `exit ${failure.code}`} (${failure.durationMs}ms)`,
	);
	const text = expanded
		? [header, ...summary, "", ...failed.map(renderExpandedFailure)].join("\n")
		: [header, ...summary].join("\n");
	box.addChild(new Text(text, 0, 0));
	return box;
}

function renderExpandedFailure(failure: FailedCommandDetails): string {
	return [
		`## ${failure.name}`,
		`command: ${failure.command}`,
		`cwd: ${failure.cwd}`,
		`env keys: ${failure.envKeys.length ? failure.envKeys.join(", ") : "none"}`,
		formatOutput("stdout", failure.stdout),
		formatOutput("stderr", failure.stderr),
	].join("\n");
}

function asFailureDetails(value: unknown): FailureDetails {
	const record = isRecord(value) ? value : {};
	return {
		failed: Array.isArray(record.failed)
			? (record.failed.filter(isFailedCommandDetails) as FailedCommandDetails[])
			: [],
	};
}

function isFailedCommandDetails(value: unknown): value is FailedCommandDetails {
	return isRecord(value) && typeof value.name === "string" && typeof value.command === "string";
}

function nonEmptyStrings(value: readonly string[] | undefined, fallback: string[]): string[] {
	const strings = value?.map((item) => item.trim()).filter(Boolean) ?? [];
	return strings.length ? strings : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
