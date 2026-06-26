import { readdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { type ExecResult, type ExtensionAPI, keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { resolveProjectRoot } from "../../shared/settings/paths.ts";
import silentCommandRunnerSettings from "./settings.ts";

const MESSAGE_TYPE = "tau:silent-command-runner";
const DEFAULT_MAX_OUTPUT_BYTES = 51200;
const DEFAULT_TIMEOUT_MS = 120000;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
	enabled: boolean;
	maxOutputBytes: number;
	commands: CommandConfig[];
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

export default function silentCommandRunnerExtension(pi: ExtensionAPI): void {
	let settings: Settings = normalizeSettings(silentCommandRunnerSettings.defaults);
	let turnStart = Date.now();
	let turnPaths = new Set<string>();
	let run: Promise<void> | undefined;
	let abortController: AbortController | undefined;

	pi.registerMessageRenderer<FailureDetails>(MESSAGE_TYPE, (message, { expanded }, theme) =>
		renderFailure(asFailureDetails(message.details), expanded, theme),
	);

	pi.on("before_agent_start", (event) => {
		if (!settings.enabled || settings.commands.length === 0) return;
		const existing = event.systemPromptOptions.appendSystemPrompt;
		event.systemPromptOptions.appendSystemPrompt = [existing, formatSilentCheckPrompt(settings.commands)]
			.filter(Boolean)
			.join("\n\n");
	});

	pi.on("session_start", async (_event, ctx) => {
		settings = normalizeSettings(await loadTauExtensionSettings(ctx, silentCommandRunnerSettings));
		turnStart = Date.now();
		turnPaths = new Set();
	});

	pi.on("agent_start", async (_event, ctx) => {
		turnStart = Date.now();
		settings = normalizeSettings(await loadTauExtensionSettings(ctx, silentCommandRunnerSettings));
		if (!settings.enabled || settings.commands.length === 0) {
			turnPaths = new Set();
			return;
		}
		const projectRoot = await resolveProjectRoot(ctx.cwd);
		turnPaths = new Set(await walkFiles(projectRoot));
	});

	pi.on("agent_end", (event, ctx) => {
		if (hasAbortedAssistantMessage(event.messages)) return;
		if (run) return;
		run = runChangedCommands(ctx.cwd, turnStart, ctx.ui.notify)
			.catch((error: unknown) => {
				ctx.ui.notify(`silent-command-runner: ${errorMessage(error)}`, "error");
			})
			.finally(() => {
				run = undefined;
			});
	});

	pi.on("session_shutdown", () => {
		abortController?.abort();
		abortController = undefined;
		run = undefined;
		turnPaths = new Set();
	});

	async function runChangedCommands(
		cwd: string,
		turnStart: number,
		notify: (message: string, type?: "info" | "warning" | "error") => void,
	): Promise<void> {
		if (!settings.enabled || settings.commands.length === 0) return;

		const projectRoot = await resolveProjectRoot(cwd);
		const paths = await walkFiles(projectRoot);
		const changed = await scanChangedCommands(projectRoot, settings.commands, paths, turnPaths, turnStart);
		if (changed.length === 0) return;

		notify(
			changed.length === 1
				? `silent-command-runner: running ${changed[0]?.name ?? "command"}`
				: `silent-command-runner: running ${changed.length} commands`,
			"info",
		);

		abortController = new AbortController();
		const failures: FailedCommandDetails[] = [];
		for (const command of changed) {
			if (changed.length > 1) notify(`silent-command-runner: running ${command.name}`, "info");
			const result = await runCommand(pi, projectRoot, command, abortController.signal, settings.maxOutputBytes);
			if (result.code !== 0 || result.killed) failures.push(result);
		}
		abortController = undefined;

		const failedNames = new Set(failures.map((failure) => failure.name));
		const passed = changed.filter((command) => !failedNames.has(command.name));
		if (passed.length > 0) notify(`silent-command-runner: passed ${formatCommandNames(passed)}`, "info");
		if (failures.length === 0) return;

		pi.sendMessage<FailureDetails>(
			{
				customType: MESSAGE_TYPE,
				content: formatAgentMessage(failures),
				display: true,
				details: { failed: failures },
			},
			{ triggerTurn: true },
		);
	}
}

function normalizeSettings(value: typeof silentCommandRunnerSettings.defaults): Settings {
	return {
		enabled: value.enabled ?? true,
		maxOutputBytes: positiveInteger(value.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
		commands: (value.commands ?? []).flatMap((command) => {
			if (command.enabled === false) return [];
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
		}),
	};
}

function formatSilentCheckPrompt(commands: readonly CommandConfig[]): string {
	return [
		"Silent checks active: these configured commands run automatically after matching file changes.",
		"Do not manually run these commands after edits. Not for verification, not as a cheap confidence check, not before saying you're done. The silent runner will run them. Wait for silent-command-runner output; if one fails, fix the reported output. Only run a manual command when the user explicitly asks or when you need a different narrow diagnostic that is not one of these automatic commands.",
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

function hasAbortedAssistantMessage(messages: readonly unknown[]): boolean {
	return messages.some(
		(message) => isRecord(message) && message.role === "assistant" && message.stopReason === "aborted",
	);
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
	const result = await pi.exec(
		envArgs.length ? "env" : "sh",
		envArgs.length ? [...envArgs, "sh", "-lc", command.command] : ["-lc", command.command],
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

function matchGlob(pattern: string, path: string): boolean {
	return matchSegments(normalizeGlob(pattern).split("/"), normalizeGlob(path).split("/"));
}

function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
	const [head, ...tail] = pattern;
	if (head === undefined) return path.length === 0;
	if (head === "**") return matchSegments(tail, path) || (path.length > 0 && matchSegments(pattern, path.slice(1)));
	const [pathHead, ...pathTail] = path;
	return pathHead !== undefined && matchSegment(head, pathHead) && matchSegments(tail, pathTail);
}

function matchSegment(pattern: string, value: string): boolean {
	const source = [...pattern]
		.map((char) => {
			if (char === "*") return "[^/]*";
			if (char === "?") return "[^/]";
			return escapeRegExp(char);
		})
		.join("");
	return new RegExp(`^${source}$`).test(value);
}

function normalizeGlob(value: string): string {
	return posixPath(value.trim())
		.replace(/^\.\//, "")
		.replace(/^\/+|\/+$/g, "");
}

function posixPath(value: string): string {
	return sep === "/" ? value : value.split(sep).join("/");
}

function nonEmptyStrings(value: readonly string[] | undefined, fallback: string[]): string[] {
	const strings = value?.map((item) => item.trim()).filter(Boolean) ?? [];
	return strings.length ? strings : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function escapeRegExp(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
