import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentDefinition {
	name: string;
	description: string;
	tools: string[];
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

export async function findProjectAgentsDir(cwd: string): Promise<string | undefined> {
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

function parseDefinition(
	path: string,
	content: string,
): { definition?: AgentDefinition; diagnostic?: AgentDiagnostic } {
	const fallbackName = basename(path, extname(path));
	try {
		const parsed = parseFrontmatter(content);
		const fields = Object.keys(parsed.frontmatter);
		const rawName = parsed.frontmatter.name;
		const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : fallbackName;
		const reasons: string[] = [];
		for (const field of fields) {
			if (!new Set(["name", "description", "tools", "model", "thinking"]).has(field))
				reasons.push(`unsupported field "${field}"`);
		}
		if (typeof rawName !== "string" || !rawName.trim()) reasons.push("name must be a non-empty string");
		const rawDescription = parsed.frontmatter.description;
		if (typeof rawDescription !== "string" || !rawDescription.trim())
			reasons.push("description must be a non-empty string");
		const rawTools = parsed.frontmatter.tools;
		if (!Array.isArray(rawTools) || rawTools.length === 0) reasons.push("tools must be a non-empty array");
		else {
			const tools = rawTools
				.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
				.map((tool) => tool.trim());
			if (tools.length !== rawTools.length) reasons.push("tools must contain non-empty strings");
			if (new Set(tools).size !== tools.length) reasons.push("tools must be unique");
			if (tools.includes("subagent")) reasons.push("tool subagent is forbidden");
		}
		if (!parsed.body.trim()) reasons.push("prompt body must be non-empty");
		const rawModel = parsed.frontmatter.model;
		if (rawModel !== undefined && (typeof rawModel !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(rawModel.trim())))
			reasons.push("model must be a provider/model string");
		const rawThinking = parsed.frontmatter.thinking;
		const thinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		if (rawThinking !== undefined && !thinkingLevels.includes(rawThinking as ThinkingLevel))
			reasons.push(`thinking must be one of ${thinkingLevels.join(", ")}`);
		if (reasons.length > 0) return { diagnostic: { path, name, reason: reasons.join("; ") } };
		return {
			definition: {
				name,
				description: (rawDescription as string).trim(),
				tools: (rawTools as string[]).map((tool) => tool.trim()),
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

async function loadScope(
	directory: string,
	required: boolean,
): Promise<Map<string, AgentDefinition | AgentDiagnostic[]>> {
	let entries;
	try {
		entries = (await readdir(directory, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && extname(entry.name) === ".md")
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch (error) {
		if (!required) return new Map();
		const reason = error instanceof Error ? error.message : "directory unavailable";
		return new Map([
			["scout", [{ path: directory, name: "scout", reason: `packaged agents unavailable: ${reason}` }]],
			[
				"context-maintenance",
				[{ path: directory, name: "context-maintenance", reason: `packaged agents unavailable: ${reason}` }],
			],
			[
				"web-research",
				[{ path: directory, name: "web-research", reason: `packaged agents unavailable: ${reason}` }],
			],
		]);
	}
	const grouped = new Map<string, Array<AgentDefinition | AgentDiagnostic>>();
	for (const entry of entries) {
		const path = join(directory, entry.name);
		let parsed;
		try {
			parsed = parseDefinition(path, await readFile(path, "utf8"));
		} catch (error) {
			parsed = {
				diagnostic: {
					path,
					name: parse(entry.name).name,
					reason: error instanceof Error ? error.message : "file unreadable",
				},
			};
		}
		const value = parsed.definition ?? parsed.diagnostic;
		if (!value) continue;
		const values = grouped.get(value.name) ?? [];
		values.push(value);
		grouped.set(value.name, values);
	}
	const scope = new Map<string, AgentDefinition | AgentDiagnostic[]>();
	for (const [name, values] of grouped) {
		if (values.length === 1 && "prompt" in values[0]) scope.set(name, values[0]);
		else {
			const diagnostics = values.map((value) =>
				"reason" in value ? value : { path: value.path, name, reason: `duplicate name "${name}" in this scope` },
			);
			if (values.length > 1) {
				for (const value of values)
					if ("reason" in value) value.reason += `; duplicate name "${name}" in this scope`;
			}
			scope.set(name, diagnostics);
		}
	}
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
