import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentDefinition {
	name: string;
	description: string;
	tools: string[];
	names: string[];
	model?: string;
	thinking?: ThinkingLevel;
	prompt: string;
	path: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentDiagnostic {
	path: string;
	name: string;
	reason: string;
}

export interface AgentDiscovery {
	agents: Map<string, AgentDefinition>;
	invalid: Map<string, AgentDiagnostic[]>;
	diagnostics: AgentDiagnostic[];
}

const BUILTIN_AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "agents");

async function directoryExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function findProjectAgentsDir(cwd: string): Promise<string | undefined> {
	const home = resolve(homedir());
	let current = resolve(cwd);
	while (current !== home) {
		const candidate = join(current, ".pi", "tau", "agents");
		if (await directoryExists(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

const ALLOWED_FRONTMATTER_FIELDS = new Set(["name", "description", "tools", "names", "model", "thinking"]);
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function validateStringList(raw: unknown, field: string, reasons: string[]): string[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0) {
		reasons.push(`${field} must be a non-empty array`);
		return undefined;
	}
	const values = raw
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
	if (values.length !== raw.length) reasons.push(`${field} must contain non-empty strings`);
	if (new Set(values).size !== values.length) reasons.push(`${field} must be unique`);
	return values;
}

function requireNonEmptyString(raw: unknown, field: string, reasons: string[]): void {
	if (typeof raw !== "string" || !raw.trim()) reasons.push(`${field} must be a non-empty string`);
}

function validateModelField(rawModel: unknown, reasons: string[]): void {
	if (rawModel === undefined) return;
	if (typeof rawModel !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(rawModel.trim()))
		reasons.push("model must be a provider/model string");
}

function validateThinkingField(rawThinking: unknown, reasons: string[]): void {
	if (rawThinking === undefined) return;
	if (!THINKING_LEVELS.includes(rawThinking as ThinkingLevel))
		reasons.push(`thinking must be one of ${THINKING_LEVELS.join(", ")}`);
}

function collectDefinitionReasons(
	parsed: ReturnType<typeof parseFrontmatter>,
	fallbackName: string,
): {
	reasons: string[];
	name: string;
	tools: string[] | undefined;
	names: string[] | undefined;
	rawDescription: unknown;
	rawModel: unknown;
	rawThinking: unknown;
} {
	const rawName = parsed.frontmatter.name;
	const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : fallbackName;
	const reasons: string[] = [];
	for (const field of Object.keys(parsed.frontmatter)) {
		if (!ALLOWED_FRONTMATTER_FIELDS.has(field)) reasons.push(`unsupported field "${field}"`);
	}
	requireNonEmptyString(rawName, "name", reasons);
	const rawDescription = parsed.frontmatter.description;
	requireNonEmptyString(rawDescription, "description", reasons);
	const tools = validateStringList(parsed.frontmatter.tools, "tools", reasons);
	if (tools?.includes("subagent")) reasons.push("tool subagent is forbidden");
	const rawNames = parsed.frontmatter.names;
	const names = rawNames === undefined ? undefined : validateStringList(rawNames, "names", reasons);
	if (!parsed.body.trim()) reasons.push("prompt body must be non-empty");
	const rawModel = parsed.frontmatter.model;
	validateModelField(rawModel, reasons);
	const rawThinking = parsed.frontmatter.thinking;
	validateThinkingField(rawThinking, reasons);
	return { reasons, name, tools, names, rawDescription, rawModel, rawThinking };
}

function parseDefinition(
	path: string,
	content: string,
): { definition?: AgentDefinition; diagnostic?: AgentDiagnostic } {
	const fallbackName = basename(path, extname(path));
	try {
		const parsed = parseFrontmatter(content);
		const { reasons, name, tools, names, rawDescription, rawModel, rawThinking } = collectDefinitionReasons(
			parsed,
			fallbackName,
		);
		if (reasons.length > 0) return { diagnostic: { path, name, reason: reasons.join("; ") } };
		return {
			definition: {
				name,
				description: (rawDescription as string).trim(),
				tools: tools ?? [],
				names: names ?? [name],
				model: typeof rawModel === "string" ? rawModel.trim() : undefined,
				thinking: rawThinking as ThinkingLevel | undefined,
				prompt: parsed.body.trim(),
				path,
			},
		};
	} catch (error) {
		return {
			diagnostic: {
				path,
				name: fallbackName,
				reason: error instanceof Error ? error.message : "invalid frontmatter",
			},
		};
	}
}

function finalizeScopeGroup(
	name: string,
	values: Array<AgentDefinition | AgentDiagnostic>,
): AgentDefinition | AgentDiagnostic[] {
	if (values.length === 1 && "prompt" in values[0]) return values[0];
	const diagnostics = values.map((value) =>
		"reason" in value ? value : { path: value.path, name, reason: `duplicate name "${name}" in this scope` },
	);
	if (values.length > 1) {
		for (const value of values) if ("reason" in value) value.reason += `; duplicate name "${name}" in this scope`;
	}
	return diagnostics;
}

async function readAgentDirectoryEntries(
	directory: string,
	required: boolean,
): Promise<
	| { kind: "entries"; entries: Array<{ name: string }> }
	| { kind: "empty" }
	| { kind: "error"; scope: Map<string, AgentDefinition | AgentDiagnostic[]> }
> {
	try {
		const entries = (await readdir(directory, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && extname(entry.name) === ".md")
			.sort((a, b) => a.name.localeCompare(b.name));
		return { kind: "entries", entries };
	} catch (error) {
		if (!required) return { kind: "empty" };
		const reason = error instanceof Error ? error.message : "directory unavailable";
		return {
			kind: "error",
			scope: new Map([
				[
					"web-research",
					[{ path: directory, name: "web-research", reason: `packaged agents unavailable: ${reason}` }],
				],
			]),
		};
	}
}

async function parseScopeFile(directory: string, entryName: string): Promise<AgentDefinition | AgentDiagnostic> {
	const path = join(directory, entryName);
	try {
		const parsed = parseDefinition(path, await readFile(path, "utf8"));
		return (
			parsed.definition ??
			parsed.diagnostic ?? {
				path,
				name: parse(entryName).name,
				reason: "empty definition",
			}
		);
	} catch (error) {
		return {
			path,
			name: parse(entryName).name,
			reason: error instanceof Error ? error.message : "file unreadable",
		};
	}
}

async function loadScope(
	directory: string,
	required: boolean,
): Promise<Map<string, AgentDefinition | AgentDiagnostic[]>> {
	const listed = await readAgentDirectoryEntries(directory, required);
	if (listed.kind === "empty") return new Map();
	if (listed.kind === "error") return listed.scope;
	const grouped = new Map<string, Array<AgentDefinition | AgentDiagnostic>>();
	for (const entry of listed.entries) {
		const value = await parseScopeFile(directory, entry.name);
		const values = grouped.get(value.name) ?? [];
		values.push(value);
		grouped.set(value.name, values);
	}
	const scope = new Map<string, AgentDefinition | AgentDiagnostic[]>();
	for (const [name, values] of grouped) scope.set(name, finalizeScopeGroup(name, values));
	return scope;
}

export async function discoverAgents(cwd: string, trusted: boolean): Promise<AgentDiscovery> {
	const scopes = [
		await loadScope(BUILTIN_AGENTS_DIR, true),
		await loadScope(join(getAgentDir(), "tau", "agents"), false),
	];
	if (trusted) {
		const project = await findProjectAgentsDir(cwd);
		if (project) scopes.push(await loadScope(project, false));
	}
	const agents = new Map<string, AgentDefinition>();
	const invalid = new Map<string, AgentDiagnostic[]>();
	const diagnostics = scopes.flatMap((scope) =>
		[...scope.values()].flatMap((value) => (Array.isArray(value) ? value : [])),
	);
	for (const scope of scopes) {
		for (const [name, value] of scope) {
			agents.delete(name);
			invalid.delete(name);
			if (Array.isArray(value)) invalid.set(name, value);
			else agents.set(name, value);
		}
	}
	return { agents, invalid, diagnostics };
}
