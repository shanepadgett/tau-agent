import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { parse, type Node, type Word } from "unbash";
import { errorText, truncAt } from "../../shared/text.ts";

const MAX_FILES = 4;
const MAX_SOURCE_BYTES = 48 * 1024;
const MAX_WORK_MS = 2000;
const MAX_REFERENCES = 32;

interface ExecutionTarget {
	path: string;
	cwd: string;
	task: string | undefined;
}

interface ReviewedFile {
	path: string;
	canonicalPath: string;
	fingerprint: string;
	source: string;
}

export type EvidenceGapReason =
	| "inspection_budget_exceeded"
	| "unsupported_execution"
	| "code_loading_configuration"
	| "unresolved_target"
	| "source_unavailable"
	| "invalid_reference"
	| "task_unavailable";

// Internal reviewer evidence is inherently bounded, not a model-visible public tool result.
export class ApprovalEvidence {
	readonly files: ReviewedFile[] = [];
	readonly gaps: string[] = [];
	readonly gapReasons = new Set<EvidenceGapReason>();
	readonly targets = new Map<string, ExecutionTarget>();
	private readonly localImports = new Map<
		string,
		{ paths: string[]; cwd: string; importRoot: string; required: boolean }
	>();
	private readonly importRoots = new Map<string, string>();
	private readonly absentPaths = new Set<string>();
	private readonly references = new Map<string, ExecutionTarget>();
	private sourceBytes = 0;
	private workStarted = 0;
	private shellNodes = 0;
	private importChecks = 0;
	readonly cwd: string;
	readonly signal: AbortSignal | undefined;

	constructor(
		cwd: string,
		signal: AbortSignal | undefined,
		toolName: "bash" | "script_runner",
		input: Record<string, unknown>,
	) {
		this.cwd = cwd;
		this.signal = signal;
		if (toolName === "bash" && typeof input.command === "string") this.shell(input.command, cwd, 0);
		if (toolName === "script_runner" && typeof input.script === "string") {
			// script_runner stages source in a new temporary directory, not in the project.
			this.source(input.script, undefined, cwd, input.language === "python3" ? ".py" : ".js");
		}
	}

	private gap(reason: EvidenceGapReason, message: string): void {
		this.gapReasons.add(reason);
		if (this.gaps.length < 8) this.gaps.push(truncAt(message, 400));
	}

	private reference(path: string, cwd: string, required: boolean, task: string | undefined): void {
		const absolute = resolve(cwd, path);
		if (this.references.size >= MAX_REFERENCES && !this.references.has(absolute)) {
			this.gap(
				required ? "source_unavailable" : "inspection_budget_exceeded",
				"Too many execution references to inspect within the review budget.",
			);
			return;
		}
		const target = { path: absolute, cwd, task };
		this.references.set(absolute, target);
		if (required) this.targets.set(`${absolute}:${task ?? ""}`, target);
	}

	private shell(command: string, cwd: string, depth: number): void {
		if (Buffer.byteLength(command) > MAX_SOURCE_BYTES) {
			this.gap("inspection_budget_exceeded", "Shell source exceeds the inspection work budget.");
			return;
		}
		if (depth > 8) {
			this.gap("inspection_budget_exceeded", "Nested shell execution exceeds the inspection budget.");
			return;
		}
		let script: ReturnType<typeof parse>;
		try {
			script = parse(command);
		} catch {
			this.gap("unsupported_execution", "The shell command could not be parsed to identify code it executes.");
			return;
		}
		if (script.errors?.length) {
			this.gap(
				"unsupported_execution",
				"The shell command has unsupported syntax, so its execution targets could not be verified.",
			);
			return;
		}
		const visit = (node: Node, currentCwd: string): string => {
			if (++this.shellNodes > 256) {
				this.gap("inspection_budget_exceeded", "Shell execution exceeds the inspection work budget.");
				return currentCwd;
			}
			switch (node.type) {
				case "Statement":
					return visit(node.command, currentCwd);
				case "AndOr":
					if (node.operators.includes("||") && /\bcd\b/.test(command))
						this.gap("unresolved_target", "Conditional directory changes make execution targets uncertain.");
					for (const child of node.commands) currentCwd = visit(child, currentCwd);
					return currentCwd;
				case "CompoundList":
					for (const child of node.commands) currentCwd = visit(child, currentCwd);
					return currentCwd;
				case "Pipeline":
					for (const child of node.commands) visit(child, currentCwd);
					return currentCwd;
				case "Subshell":
					visit(node.body, currentCwd);
					return currentCwd;
				case "BraceGroup":
					return visit(node.body, currentCwd);
				case "Command": {
					if (!node.name) return currentCwd;
					const name = staticWord(node.name);
					const args = node.suffix.map(staticWord);
					if (!name) {
						this.gap(
							"unresolved_target",
							"The executable name is computed at runtime and could not be inspected.",
						);
						return currentCwd;
					}
					const executable = basename(name);
					for (const arg of args) {
						if (arg && /\.(?:py|js|mjs|cjs|ts|sh|bash|json)$/.test(arg))
							this.reference(arg, currentCwd, false, undefined);
					}
					for (const word of [node.name, ...node.suffix]) {
						const parts = [...(word.parts ?? [])];
						for (const part of parts) {
							if (part.type === "DoubleQuoted" || part.type === "LocaleString") parts.push(...part.parts);
							if (part.type === "CommandExpansion" || part.type === "ProcessSubstitution") {
								if (part.inner) this.shell(part.inner, currentCwd, depth + 1);
								else
									this.gap("unresolved_target", "A nested executable shell expression could not be resolved.");
							}
						}
					}
					if (node.prefix.some((prefix) => /^(?:PATH|PYTHONPATH|NODE_OPTIONS|BASH_ENV|ENV)=/.test(prefix.text))) {
						this.gap(
							"code_loading_configuration",
							"The command changes code-loading configuration that could hide execution targets.",
						);
					}
					if (executable === "cd") {
						const path = args[0];
						if (!path || path.startsWith("-")) {
							this.gap(
								"unresolved_target",
								"The working directory could not be resolved for execution inspection.",
							);
							return currentCwd;
						}
						return resolve(currentCwd, path);
					}
					if (["env", "command", "exec", "sudo", "timeout", "nohup"].includes(executable)) {
						this.gap(
							"unresolved_target",
							`Automatic inspection did not resolve execution through ${executable}; assess the visible inner command and whether any executable code remains hidden.`,
						);
						return currentCwd;
					}
					if (["npm", "pnpm", "yarn"].includes(executable)) {
						const task = args[0] === "run" || args[0] === "run-script" ? args[1] : args[0];
						const packageTask =
							executable !== "npm" ||
							["run", "run-script", "start", "test", "stop", "restart"].includes(args[0] ?? "");
						if (
							packageTask &&
							task &&
							!["install", "ci", "add", "remove", "uninstall", "--version", "-v", "help"].includes(task)
						) {
							const separator = args.indexOf("--");
							const taskArgs = separator < 0 ? args : args.slice(0, separator);
							if (taskArgs.some((arg) => arg === undefined || arg.startsWith("-"))) {
								this.gap(
									"unresolved_target",
									"Package-task options could change the manifest or execution target.",
								);
							} else {
								this.reference("package.json", currentCwd, true, task);
								for (const config of executable === "yarn"
									? [".npmrc", ".yarnrc", ".yarnrc.yml"]
									: [".npmrc"]) {
									this.localImports.set(`${currentCwd}:${config}`, {
										paths: [resolve(currentCwd, config)],
										cwd: currentCwd,
										importRoot: currentCwd,
										required: false,
									});
								}
							}
						}
						return currentCwd;
					}
					if (/^(?:python(?:\d+(?:\.\d+)?)?|node|deno|bash|sh|zsh|dash)$/.test(executable)) {
						const shell = ["bash", "sh", "zsh", "dash"].includes(executable);
						const consumed = new Set<number>();
						for (let index = 0; index < args.length; index++) {
							const option = args[index];
							if (["-r", "--require", "--import", "--loader", "--rcfile"].includes(option ?? "")) {
								const path = args[index + 1];
								if (path) this.reference(path, currentCwd, true, undefined);
								else this.gap("unresolved_target", "A runtime preload target is computed or missing.");
								consumed.add(index + 1);
							}
							if (
								option?.startsWith("--require=") ||
								option?.startsWith("--import=") ||
								option?.startsWith("--loader=")
							)
								this.reference(option.slice(option.indexOf("=") + 1), currentCwd, true, undefined);
						}
						const moduleIndex = args.indexOf("-m");
						if (executable.startsWith("python") && moduleIndex >= 0) {
							const module = args[moduleIndex + 1];
							if (module && /^[\w.]+$/.test(module)) {
								const path = module.replaceAll(".", "/");
								this.localImports.set(`${currentCwd}:${module}`, {
									paths: [resolve(currentCwd, `${path}.py`), resolve(currentCwd, path, "__main__.py")],
									cwd: currentCwd,
									importRoot: currentCwd,
									required: false,
								});
								this.localImports.set(`${currentCwd}:${module}/__init__`, {
									paths: [resolve(currentCwd, path, "__init__.py")],
									cwd: currentCwd,
									importRoot: currentCwd,
									required: false,
								});
							} else this.gap("unresolved_target", "The Python module execution target is computed at runtime.");
							return currentCwd;
						}
						const inlineIndex = args.findIndex(
							(arg) =>
								arg === "-c" ||
								arg === "-e" ||
								arg === "--eval" ||
								arg === "--print" ||
								arg === "-p" ||
								(shell && /^-[a-z]*c[a-z]*$/.test(arg ?? "")),
						);
						if (inlineIndex >= 0) {
							const source = args[inlineIndex + 1];
							if (source === undefined)
								this.gap("unresolved_target", "Inline executable source is computed at runtime.");
							else if (shell) this.shell(source, currentCwd, depth + 1);
							else this.source(source, currentCwd, currentCwd, executable.startsWith("python") ? ".py" : ".js");
							return currentCwd;
						}
						const target = args.find(
							(arg, index) =>
								!consumed.has(index) && (arg === undefined || (arg !== "run" && !arg.startsWith("-"))),
						);
						if (!target || target === "-") {
							const redirect = node.redirects.find(
								(item) => item.content !== undefined || item.operator === "<",
							);
							if (redirect?.content !== undefined) {
								if (shell) this.shell(redirect.content, currentCwd, depth + 1);
								else
									this.source(
										redirect.content,
										currentCwd,
										currentCwd,
										executable.startsWith("python") ? ".py" : ".js",
									);
							} else if (redirect?.target && staticWord(redirect.target)) {
								this.reference(redirect.target.value, currentCwd, true, undefined);
							} else
								this.gap(
									"unresolved_target",
									"Executable input comes from a computed path or standard input and could not be inspected.",
								);
						} else this.reference(target, currentCwd, true, undefined);
						return currentCwd;
					}
					if (
						executable === "source" ||
						name === "." ||
						(name.includes("/") && !/^(?:\/usr\/bin|\/bin|\/usr\/local\/bin|\/opt\/homebrew\/bin)\//.test(name))
					) {
						const target = executable === "source" || name === "." ? args[0] : name;
						if (target) this.reference(target, currentCwd, true, undefined);
						else this.gap("unresolved_target", "The sourced script path is computed at runtime.");
					}
					return currentCwd;
				}
				default:
					this.gap(
						"unsupported_execution",
						"Shell control flow could hide execution targets; this syntax is not inspected automatically.",
					);
					return currentCwd;
			}
		};
		for (const statement of script.commands) cwd = visit(statement, cwd);
	}

	private source(source: string, importCwd: string | undefined, executionCwd: string, extension: string): void {
		if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
			this.gap("inspection_budget_exceeded", "Inline source exceeds the inspection work budget.");
			return;
		}
		if ([".sh", ".bash", ".zsh"].includes(extension) || /^#![^\n]*\b(?:sh|bash|zsh)\b/.test(source)) {
			this.shell(source, executionCwd, 0);
			return;
		}
		if (/^#![^\n]*python/.test(source)) extension = ".py";
		if (/\bsys\.path\s*(?:=|\.(?:insert|append|extend)\s*\()/.test(source))
			this.gap(
				"code_loading_configuration",
				"The script changes Python's code search path, so its local imports could not be resolved reliably.",
			);
		// Exact quoted file references are available only when the reviewer asks for them.
		for (const match of source.matchAll(/["']([^"'\n]+\.(?:py|js|mjs|cjs|ts|sh|bash|json))["']/g)) {
			if (match[1]) this.reference(match[1], executionCwd, false, undefined);
		}
		for (const match of source.matchAll(
			/(?:\brunpy\.run_path\s*\(\s*|\b(?:exec|eval)\s*\(\s*(?:open|(?:fs\.)?readFileSync)\s*\(\s*)["']([^"'\n]+)["']/g,
		)) {
			if (match[1]) this.reference(match[1], executionCwd, true, undefined);
		}
		if (extension === ".py") {
			for (const match of source.matchAll(
				/(?:^|[;\n])\s*(?:from\s+([\w.]+)\s+import\s+([^;\n]+)|import\s+([^;\n]+))/g,
			)) {
				if (this.localImports.size >= MAX_REFERENCES) {
					this.gap(
						"inspection_budget_exceeded",
						"Too many local import references to inspect within the review budget.",
					);
					break;
				}
				const modules = match[1]
					? [match[1]]
					: (match[3] ?? "")
							.replace(/#.*/, "")
							.split(",")
							.map((module) => module.trim().split(/\s+as\s+/)[0] ?? "");
				for (const module of modules) {
					if (!module) continue;
					if (this.localImports.size >= MAX_REFERENCES) {
						this.gap(
							"inspection_budget_exceeded",
							"Too many local import references to inspect within the review budget.",
						);
						break;
					}
					if (module.startsWith(".") || !/^[\w.]+$/.test(module)) {
						this.gap(
							"source_unavailable",
							"A Python import could not be resolved without additional package context.",
						);
						continue;
					}
					if (importCwd === undefined) continue;
					const path = module.replaceAll(".", "/");
					this.localImports.set(`${importCwd}:${module}`, {
						paths: [resolve(importCwd, `${path}.py`), resolve(importCwd, path, "__init__.py")],
						cwd: executionCwd,
						importRoot: importCwd,
						required: false,
					});
					const segments = module.split(".");
					if (segments.length > 8) {
						this.gap("inspection_budget_exceeded", "Python import depth exceeds the inspection work budget.");
						continue;
					}
					for (let index = 1; index < segments.length && this.localImports.size < MAX_REFERENCES; index++) {
						const parent = segments.slice(0, index).join("/");
						this.localImports.set(`${importCwd}:${parent}/__init__`, {
							paths: [resolve(importCwd, parent, "__init__.py")],
							cwd: executionCwd,
							importRoot: importCwd,
							required: false,
						});
					}
					if (match[1] && match[2]) {
						for (const member of match[2].replace(/#.*/, "").replace(/[()]/g, "").split(",")) {
							const name = member.trim().split(/\s+as\s+/)[0];
							if (name && /^\w+$/.test(name) && this.localImports.size < MAX_REFERENCES) {
								this.localImports.set(`${importCwd}:${module}.${name}`, {
									paths: [
										resolve(importCwd, path, `${name}.py`),
										resolve(importCwd, path, name, "__init__.py"),
									],
									cwd: executionCwd,
									importRoot: importCwd,
									required: false,
								});
							}
						}
					}
				}
			}
		} else {
			for (const match of source.matchAll(
				/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']((?:\.|\/)[^"'\n]+)["']/g,
			)) {
				if (this.localImports.size >= MAX_REFERENCES) {
					this.gap("source_unavailable", "Too many local import references to inspect within the review budget.");
					break;
				}
				const path = match[1];
				if (!path) continue;
				if (importCwd === undefined && !path.startsWith("/")) {
					this.gap(
						"source_unavailable",
						"Relative script_runner imports resolve in a temporary source directory; their code could not be inspected.",
					);
					continue;
				}
				const base = importCwd ?? executionCwd;
				if (extname(path)) this.reference(resolve(base, path), executionCwd, true, undefined);
				else
					this.localImports.set(`${base}:${path}`, {
						paths: ["", ".js", ".json", ".mjs", ".cjs", ".ts"].map((suffix) => resolve(base, path + suffix)),
						cwd: executionCwd,
						importRoot: base,
						required: true,
					});
			}
		}
		for (const match of source.matchAll(
			/(?:\bexecSync|\bexec|\bos\.system|\bsubprocess\.(?:run|call|Popen|check_call|check_output))\s*\(\s*["']([^"'\n]+)["']/g,
		)) {
			if (match[1]) this.shell(match[1], executionCwd, 0);
		}
		for (const match of source.matchAll(
			/(?:\bsubprocess\.(?:run|call|Popen|check_call|check_output)\s*\(\s*|\b(?:spawn(?:Sync)?|execFile(?:Sync)?)\s*\(\s*["']([^"'\n]+)["']\s*,\s*)\[([^\]]{0,4096})\]/g,
		)) {
			const body = match[2] ?? "";
			const words = [
				...(match[1] ? [match[1]] : []),
				...[...body.matchAll(/["']([^"'\n]*)["']/g)].map((word) => word[1] ?? ""),
			];
			if (body.replace(/["'][^"'\n]*["']/g, "").replace(/[\s,]/g, ""))
				this.gap("unresolved_target", "A subprocess argument list is computed at runtime.");
			else this.shell(words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" "), executionCwd, 0);
		}
	}

	async prepare(): Promise<void> {
		if (!this.workStarted) this.workStarted = Date.now();
		for (const [key, { paths, cwd, importRoot, required }] of this.localImports) {
			this.localImports.delete(key);
			let found = false;
			for (const path of paths) {
				if (++this.importChecks > MAX_REFERENCES || Date.now() - this.workStarted > MAX_WORK_MS) {
					this.gap(
						required ? "source_unavailable" : "inspection_budget_exceeded",
						"Local import resolution exceeds the inspection budget.",
					);
					return;
				}
				this.signal?.throwIfAborted();
				try {
					await boundedIO(stat(path), this.workStarted + MAX_WORK_MS);
					this.reference(path, cwd, true, undefined);
					this.importRoots.set(path, importRoot);
					found = true;
					break;
				} catch (error) {
					if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
						this.absentPaths.add(path);
					else this.gap("source_unavailable", `Could not check local import ${path}.`);
				}
			}
			if (!found && required)
				this.gap("source_unavailable", `The local import ${key} could not be resolved to an exact source file.`);
		}
	}

	async inspect(requested: readonly string[]): Promise<void> {
		this.workStarted = Date.now();
		for (const path of requested) {
			const target = this.references.get(resolve(this.cwd, path));
			if (target) this.targets.set(`${target.path}:${target.task ?? ""}`, target);
			else
				this.gap(
					"invalid_reference",
					`The requested file ${path} is not a concrete execution reference in this request.`,
				);
		}
		if (this.targets.size === 0)
			this.gap(
				"unresolved_target",
				"The reviewer needs more execution evidence, but no exact local code target could be identified.",
			);
		const seen = new Set<string>();
		for (const [key, target] of this.targets) {
			if (seen.has(key)) continue;
			seen.add(key);
			if (this.files.length >= MAX_FILES || Date.now() - this.workStarted > MAX_WORK_MS) {
				this.gap(
					"inspection_budget_exceeded",
					"The directly referenced code exceeds the four-file or two-second inspection budget.",
				);
				break;
			}
			this.signal?.throwIfAborted();
			try {
				const file = await boundedIO(
					readEvidenceFile(target.path, MAX_SOURCE_BYTES - this.sourceBytes),
					this.workStarted + MAX_WORK_MS,
				);
				this.sourceBytes += Buffer.byteLength(file.source);
				this.files.push(file);
				if (basename(target.path) === ".npmrc") {
					const executionSettings: string[] = [];
					for (const line of file.source.split("\n")) {
						const setting = /^\s*(script-shell|node-options|onload-script)\s*=\s*(.*?)\s*$/.exec(line);
						if (!setting) continue;
						executionSettings.push(line);
						if (setting[1] === "node-options") this.shell(`node ${setting[2]} -e ''`, target.cwd, 0);
						else if (setting[2]?.includes("/") && !/^(?:\/bin|\/usr\/bin)\//.test(setting[2]))
							this.reference(setting[2], target.cwd, true, undefined);
						else if (setting[1] === "onload-script")
							this.gap(
								"code_loading_configuration",
								"Project npm configuration loads additional code that could not be resolved.",
							);
					}
					// Registry credentials are irrelevant to execution review and must not be sent.
					file.source = executionSettings.join("\n");
				} else if ([".yarnrc", ".yarnrc.yml"].includes(basename(target.path))) {
					file.source = "Project Yarn configuration is present; executable settings were not resolved.";
					this.gap(
						"code_loading_configuration",
						"Project Yarn configuration can change the executable or load plugins; those settings could not be inspected automatically.",
					);
				} else if (target.task !== undefined) {
					const manifest: unknown = JSON.parse(file.source);
					if (
						!manifest ||
						typeof manifest !== "object" ||
						!("scripts" in manifest) ||
						!manifest.scripts ||
						typeof manifest.scripts !== "object"
					) {
						this.gap("task_unavailable", `No task definitions were found for ${target.task}.`);
						continue;
					}
					const scripts = manifest.scripts as Record<string, unknown>;
					const selected: Record<string, string> = {};
					for (const task of [`pre${target.task}`, target.task, `post${target.task}`]) {
						const command = scripts[task];
						if (typeof command === "string") {
							selected[task] = command;
							this.shell(command, target.cwd, 0);
						}
					}
					if (!(target.task in selected))
						this.gap("task_unavailable", `The requested package task ${target.task} was not found.`);
					// Keep the full-file fingerprint, but send only relevant task definitions.
					file.source = JSON.stringify({
						scripts: selected,
						type: "type" in manifest ? manifest.type : undefined,
					});
				} else {
					const python = extname(target.path) === ".py" || /^#![^\n]*python/.test(file.source);
					const importRoot = python
						? (this.importRoots.get(target.path) ?? dirname(file.canonicalPath))
						: dirname(file.canonicalPath);
					this.source(file.source, importRoot, target.cwd, extname(target.path));
				}
				await this.prepare();
			} catch (error) {
				if (this.signal?.aborted) throw error;
				this.gap("source_unavailable", `Could not inspect ${target.path}: ${errorText(error)}`);
			}
		}
		if (Date.now() - this.workStarted > MAX_WORK_MS)
			this.gap("inspection_budget_exceeded", "Evidence collection exceeded its two-second work budget.");
		this.files.sort((a, b) => a.path.localeCompare(b.path));
	}

	// fallow-ignore-next-line unused-class-member -- called through ToolReviewResult.evidence in tool-approval/index.ts before execution and after confirmation
	async isFresh(): Promise<boolean> {
		const deadline = Date.now() + MAX_WORK_MS;
		for (const file of this.files) {
			this.signal?.throwIfAborted();
			try {
				const current = await boundedIO(readEvidenceFile(file.path, MAX_SOURCE_BYTES), deadline);
				if (current.canonicalPath !== file.canonicalPath || current.fingerprint !== file.fingerprint) return false;
			} catch {
				return false;
			}
		}
		for (const path of this.absentPaths) {
			try {
				await boundedIO(stat(path), deadline);
				return false;
			} catch (error) {
				if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") return false;
			}
		}
		return true;
	}
}

function staticWord(word: Word): string | undefined {
	if (
		word.parts?.some((part) => {
			if (part.type === "DoubleQuoted" || part.type === "LocaleString")
				return part.parts.some((child) => child.type !== "Literal");
			return !["Literal", "SingleQuoted", "AnsiCQuoted"].includes(part.type);
		})
	)
		return undefined;
	return word.value;
}

async function readEvidenceFile(path: string, maxBytes: number): Promise<ReviewedFile> {
	const canonicalPath = await realpath(path);
	const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("Execution target is not a regular source file.");
		if (info.size > maxBytes) throw new Error("Source exceeds the 48 KiB inspection budget.");
		const bytes = Buffer.alloc(maxBytes + 1);
		let total = 0;
		while (total < bytes.length) {
			const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
			if (!bytesRead) break;
			total += bytesRead;
		}
		if (total > maxBytes) throw new Error("Source exceeds the 48 KiB inspection budget.");
		const content = bytes.subarray(0, total);
		if (content.includes(0)) throw new Error("Execution target is not text source.");
		return {
			path,
			canonicalPath,
			fingerprint: createHash("sha256").update(content).digest("hex"),
			source: content.toString("utf8"),
		};
	} finally {
		await handle.close();
	}
}

async function boundedIO<T>(operation: Promise<T>, deadline: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("File inspection exceeded its two-second work budget.")),
					Math.max(0, deadline - Date.now()),
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
