import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type ExecResult, type ExtensionAPI, keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { registerPromptSource } from "../../shared/prompt-contributions.ts";
import { matchGlob, posixPath } from "../../shared/glob.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { resolveProjectRoot } from "../../shared/settings/paths.ts";
import silentCommandRunnerSettings from "./settings.ts";

const MESSAGE_TYPE = "tau:silent-command-runner";
const DEFAULT_MAX_OUTPUT_BYTES = 51200;
const DEFAULT_TIMEOUT_MS = 120000;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WRITE_TOOLS = new Set([
	"patch",
	"write",
	"edit",
	"bash",
	"powershell",
	"script_runner",
	"codemode",
	"image_gen",
	"screenshot_window",
]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "tool_search"]);
const WALK_SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".cache",
	".next",
	".turbo",
	".parcel-cache",
	"out",
]);
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
	timeoutMs: number;
}

interface Settings {
	maxOutputBytes: number;
	afterWrite: CommandConfig[];
	afterRun: CommandConfig[];
}

type Snapshot = Map<string, string>;

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

export default function silentCommandRunnerExtension(pi: ExtensionAPI): void {
	let settings: Settings = normalizeSettings(silentCommandRunnerSettings.defaults);
	let turnStart = Date.now();
	let turnPaths = new Set<string>();
	let abortController: AbortController | undefined;
	let sessionActive = false;
	const snapshots = new Map<string, { projectRoot: string; files: Snapshot }>();
	const fixedHashes: Snapshot = new Map();
	const fixerControllers = new Set<AbortController>();
	let fixerQueue: Promise<void> = Promise.resolve();

	pi.registerMessageRenderer<FailureDetails>(MESSAGE_TYPE, (message, { expanded }, theme) =>
		renderFailure(asFailureDetails(message.details), expanded, theme),
	);

	pi.on("session_start", async (_event, ctx) => {
		settings = normalizeSettings(await loadTauExtensionSettings(ctx, silentCommandRunnerSettings));
		sessionActive = true;
		turnStart = Date.now();
		turnPaths = new Set();
		snapshots.clear();
		fixedHashes.clear();
	});

	registerPromptSource(pi, {
		key: "checks/instructions",
		section: "automatic-checks",
		refresh: "append",
		async read(ctx) {
			settings = normalizeSettings(await loadTauExtensionSettings(ctx, silentCommandRunnerSettings));
			if (settings.afterWrite.length === 0 && settings.afterRun.length === 0) return "";
			return [
				...(settings.afterWrite.length
					? [
							"Do not manually run these automatic post-write commands. They run silently after modifying tools finish, once per outer codemode call. Do not claim they passed; end-of-run checks report remaining problems.",
							...settings.afterWrite.map(formatSilentCheckCommand),
						]
					: []),
				...(settings.afterRun.length ? [formatSilentCheckPrompt(settings.afterRun)] : []),
			].join("\n");
		},
	});

	pi.on("agent_start", async (_event, ctx) => {
		await fixerQueue;
		snapshots.clear();
		fixedHashes.clear();
		turnStart = Date.now();
		turnPaths =
			settings.afterRun.length > 0
				? new Set(await walkFiles(await resolveProjectRoot(ctx.cwd)))
				: new Set();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!sessionActive || settings.afterWrite.length === 0) return;
		// Any descendant belongs to the outer snapshot, including nested orchestrators.
		if ([...snapshots.keys()].some((id) => event.toolCallId.startsWith(`${id}/`))) return;
		const tool = pi.getAllTools().find((entry) => entry.name === event.toolName);
		if (
			!WRITE_TOOLS.has(event.toolName) &&
			(READ_TOOLS.has(event.toolName) || tool?.annotations?.readOnlyHint === true)
		) return;
		await fixerQueue;
		if (!sessionActive) return;
		const projectRoot = await resolveProjectRoot(ctx.cwd);
		snapshots.set(event.toolCallId, {
			projectRoot,
			files: await snapshotFiles(projectRoot, settings.afterWrite),
		});
	});

	pi.on("tool_result", async (event, ctx) => {
		const snapshot = snapshots.get(event.toolCallId);
		if (!snapshot) return;
		// Keep the snapshot registered until processing completes so descendants stay grouped.
		fixerQueue = fixerQueue.then(async () => {
			if (!sessionActive || ctx.signal?.aborted) return;
			const current = await snapshotFiles(snapshot.projectRoot, settings.afterWrite);
			const changed = [...current.keys()].filter(
				(path) => current.get(path) !== snapshot.files.get(path) && current.get(path) !== fixedHashes.get(path),
			);
			if (changed.length === 0) return;
			const controller = new AbortController();
			fixerControllers.add(controller);
			const cancel = () => controller.abort();
			ctx.signal?.addEventListener("abort", cancel, { once: true });
			if (ctx.signal?.aborted) controller.abort();
			try {
				for (const command of settings.afterWrite) {
					if (!sessionActive || controller.signal.aborted) return;
					const files = changed.filter((path) => matchesCommand(path, command));
					if (files.length === 0) continue;
					try {
						await runCommand(
							pi,
							snapshot.projectRoot,
							command,
							controller.signal,
							0,
							files.map((path) => resolve(snapshot.projectRoot, path)),
						);
					} catch {
						// Final checks own failure reporting; a failed fixer must not stop the next one.
					}
				}
				const after = await snapshotFiles(snapshot.projectRoot, settings.afterWrite);
				for (const path of changed) {
					const hash = after.get(path);
					if (hash === undefined) fixedHashes.delete(path);
					else fixedHashes.set(path, hash);
				}
			} finally {
				ctx.signal?.removeEventListener("abort", cancel);
				fixerControllers.delete(controller);
			}
		}).catch((error: unknown) => {
			if (sessionActive && !ctx.signal?.aborted) ctx.ui.notify(`silent-command-runner: ${errorMessage(error)}`, "error");
		}).finally(() => snapshots.delete(event.toolCallId));
		await fixerQueue;
	});

	// The last boundary before the run settles: failures continue the run instead of starting a new one.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed") return undefined;
		try {
			await fixerQueue;
			const failures = await runChangedCommands(ctx.cwd, ctx.ui.notify);
			if (!failures || failures.length === 0) return undefined;
			return {
				entries: [
					...event.entries,
					{
						type: "custom_message" as const,
						customType: MESSAGE_TYPE,
						content: formatAgentMessage(failures),
						display: true,
						details: { failed: [...failures] } satisfies FailureDetails,
					},
				],
				continue: true,
			};
		} catch (error: unknown) {
			ctx.ui.notify(`silent-command-runner: ${errorMessage(error)}`, "error");
			return undefined;
		}
	});

	pi.on("session_shutdown", () => {
		sessionActive = false;
		abortController?.abort();
		abortController = undefined;
		turnPaths = new Set();
		for (const controller of fixerControllers) controller.abort();
		snapshots.clear();
		fixedHashes.clear();
	});

	async function collectCommandFailures(
		projectRoot: string,
		changed: readonly CommandConfig[],
		notify: (message: string, type?: "info" | "warning" | "error") => void,
	): Promise<FailedCommandDetails[] | undefined> {
		const failures: FailedCommandDetails[] = [];
		const controller = new AbortController();
		abortController = controller;
		try {
			for (const command of changed) {
				if (changed.length > 1) notify(`silent-command-runner: running ${command.name}`, "info");
				let result: FailedCommandDetails;
				try {
					result = await runCommand(pi, projectRoot, command, controller.signal, settings.maxOutputBytes, []);
				} catch (error: unknown) {
					if (controller.signal.aborted) return undefined;
					throw error;
				}
				if (controller.signal.aborted) return undefined;
				if (result.code !== 0 || result.killed) failures.push(result);
			}
		} finally {
			if (abortController === controller) abortController = undefined;
		}
		return failures;
	}

	async function runChangedCommands(
		cwd: string,
		notify: (message: string, type?: "info" | "warning" | "error") => void,
	): Promise<FailedCommandDetails[] | undefined> {
		if (settings.afterRun.length === 0) return undefined;

		const projectRoot = await resolveProjectRoot(cwd);
		const paths = await walkFiles(projectRoot);
		const changed = await scanChangedCommands(projectRoot, settings.afterRun, paths, turnPaths, turnStart);
		if (!sessionActive || changed.length === 0) return undefined;

		notify(
			changed.length === 1
				? `silent-command-runner: running ${changed[0]?.name ?? "command"}`
				: `silent-command-runner: running ${changed.length} commands`,
			"info",
		);

		const failures = await collectCommandFailures(projectRoot, changed, notify);
		if (failures === undefined || !sessionActive) return undefined;
		const failedNames = new Set(failures.map((failure) => failure.name));
		const passed = changed.filter((command) => !failedNames.has(command.name));
		if (passed.length > 0) notify(`silent-command-runner: passed ${formatCommandNames(passed)}`, "info");
		if (failures.length > 0) {
			// Only files the agent changes after this report can trigger another check and continuation.
			turnStart = Date.now();
			turnPaths = new Set(paths);
		}
		return failures;
	}
}

function normalizeSettings(value: typeof silentCommandRunnerSettings.defaults): Settings {
	return {
		maxOutputBytes: positiveInteger(value.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
		afterWrite: normalizeCommands(value.afterWrite),
		afterRun: normalizeCommands(value.afterRun),
	};
}

function normalizeCommands(commands: typeof silentCommandRunnerSettings.defaults.afterWrite): CommandConfig[] {
	return commands.flatMap((command) => {
		const name = command.name.trim();
		const commandText = command.command.trim();
		if (!name || !commandText) return [];
		return [
			{
				name,
				command: commandText,
				cwd: command.cwd?.trim() || ".",
				env: command.env ?? {},
				details: command.details?.trim() || undefined,
				includeGlobs: nonEmptyStrings(command.includeGlobs, ["**/*"]),
				excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS, ...nonEmptyStrings(command.excludeGlobs, [])],
				timeoutMs: positiveInteger(command.timeoutMs, DEFAULT_TIMEOUT_MS),
			},
		];
	});
}

async function snapshotFiles(projectRoot: string, commands: readonly CommandConfig[]): Promise<Snapshot> {
	const files: Snapshot = new Map();
	for (const path of await walkFiles(projectRoot)) {
		if (!commands.some((command) => matchesCommand(path, command))) continue;
		try {
			files.set(path, createHash("sha256").update(await readFile(resolve(projectRoot, path))).digest("hex"));
		} catch (error: unknown) {
			if (!isRecord(error) || error.code !== "ENOENT") throw error;
		}
	}
	return files;
}

function formatSilentCheckPrompt(commands: readonly CommandConfig[]): string {
	return [
		"Do not manually run the commands listed below. They run automatically after matching changes. Complete the work and finish normally; treat it as correct unless a failure is reported. Do not announce pending validation, hedge completion because of these commands, or tell the user that checks will run or rerun. If a failure is reported, fix it and describe the correction, then finish normally. Do not claim commands passed without evidence. Targeted checks outside this list remain allowed when needed.",
		"Automatic commands:",
		...commands.map(formatSilentCheckCommand),
	].join("\n");
}

function formatSilentCheckCommand(command: CommandConfig): string {
	return [
		`- ${command.name}: ${command.command}`,
		...(command.details ? [`  details: ${command.details}`] : []),
		`  cwd: ${command.cwd}`,
		`  triggers: ${command.includeGlobs.join(", ")}`,
		...(command.excludeGlobs.length ? [`  excludes: ${command.excludeGlobs.join(", ")}`] : []),
	].join("\n");
}

async function scanChangedCommands(
	projectRoot: string,
	commands: readonly CommandConfig[],
	paths: readonly string[],
	turnPaths: ReadonlySet<string>,
	turnStart: number,
): Promise<CommandConfig[]> {
	const currentSet = new Set(paths);
	const deletedPaths = [...turnPaths].filter((path) => !currentSet.has(path));
	const changed: CommandConfig[] = [];
	for (const command of commands) {
		const matched = paths.filter((path) => matchesCommand(path, command));
		const hasDeleted = deletedPaths.some((path) => matchesCommand(path, command));
		if (hasDeleted || (await hasChangedFile(projectRoot, matched, turnStart))) changed.push(command);
	}
	return changed;
}

async function hasChangedFile(projectRoot: string, paths: readonly string[], turnStart: number): Promise<boolean> {
	for (const path of paths) {
		try {
			if ((await stat(resolve(projectRoot, path))).mtimeMs >= turnStart) return true;
		} catch {
			// unreadable file — treat as changed to avoid skipping checks
			return true;
		}
	}
	return false;
}

async function walkFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	await walkDir(root, "", files);
	return files;
}

async function walkDir(root: string, relativeDir: string, files: string[]): Promise<void> {
	const dir = relativeDir ? resolve(root, relativeDir) : root;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const relativePath = posixPath(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
		if (entry.isDirectory()) {
			if (!WALK_SKIP_DIRS.has(entry.name)) await walkDir(root, relativePath, files);
			continue;
		}
		if (entry.isFile()) files.push(relativePath);
	}
}

function matchesCommand(path: string, command: CommandConfig): boolean {
	return (
		command.includeGlobs.some((glob) => matchGlob(glob, path)) &&
		!command.excludeGlobs.some((glob) => matchGlob(glob, path))
	);
}

async function runCommand(
	pi: ExtensionAPI,
	projectRoot: string,
	command: CommandConfig,
	signal: AbortSignal,
	maxOutputBytes: number,
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
	const result = await pi.exec(
		envArgs.length ? "env" : "sh",
		envArgs.length ? [...envArgs, "sh", ...shellArgs] : shellArgs,
		{
			cwd,
			signal,
			timeout: command.timeoutMs,
		},
	);
	return commandDetails(command, cwd, result, Date.now() - start, maxOutputBytes);
}

function formatCommandNames(commands: readonly CommandConfig[]): string {
	return commands.map((command) => command.name).join(", ");
}

function commandDetails(
	command: CommandConfig,
	cwd: string,
	result: ExecResult,
	durationMs: number,
	maxOutputBytes: number,
): FailedCommandDetails {
	return {
		name: command.name,
		command: command.command,
		cwd,
		envKeys: Object.keys(command.env).sort(),
		code: result.code,
		killed: result.killed,
		durationMs,
		stdout: tailBytes(result.stdout, maxOutputBytes),
		stderr: tailBytes(result.stderr, maxOutputBytes),
	};
}

function tailBytes(value: string, maxBytes: number): OutputTail {
	const buffer = Buffer.from(value);
	if (buffer.byteLength <= maxBytes) return { content: value, truncated: false };
	return { content: buffer.subarray(buffer.byteLength - maxBytes).toString("utf8"), truncated: true };
}

function formatAgentMessage(failures: readonly FailedCommandDetails[]): string {
	return [
		`silent-command-runner failed: ${failures.length} command${failures.length === 1 ? "" : "s"}`,
		...failures.map(formatAgentFailure),
		"Fix the reported failures without manually rerunning these commands. Describe the correction and finish normally; do not announce validation or reruns.",
	].join("\n\n");
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
