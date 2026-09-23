import {
	formatSkillsForPrompt,
	getDocsPath,
	getExamplesPath,
	getReadmePath,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { collectPromptSources, type PromptValue } from "../../shared/prompt-contributions.ts";
import { FIXED_INSTRUCTIONS } from "./prompt.ts";

export async function readPromptValues(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	inputs: BuildSystemPromptOptions,
	capture: boolean,
): Promise<PromptValue[]> {
	const sources = collectPromptSources(pi).filter((source) => capture || source.refresh === "append");
	const values = await Promise.all(
		sources.map(async (source) => ({
			key: source.key,
			section: source.section,
			refresh: source.refresh,
			text: await source.read(ctx),
		})),
	);
	const active = new Set(pi.getActiveTools());
	const tools = pi.getAllTools().filter((tool) => active.has(tool.name));
	values.push(
		{
			key: "pi/tools",
			section: "tools",
			refresh: "append",
			text: tools
				.map((tool) => `- ${tool.name}: ${inputs.toolSnippets?.[tool.name] ?? tool.description}`)
				.join("\n"),
		},
		{
			key: "pi/tool-guidance",
			section: "tool-guidance",
			refresh: "append",
			text: [
				...new Set([
					...(active.has("bash") ? ["Use bash for file operations like ls, rg, find."] : []),
					...tools.flatMap((tool) => tool.promptGuidelines ?? []),
					...(inputs.promptGuidelines ?? []),
				]),
			]
				.map((rule) => `- ${rule}`)
				.join("\n"),
		},
	);
	return values.sort((a, b) => a.key.localeCompare(b.key, "en"));
}

export function renderBaseline(inputs: BuildSystemPromptOptions, values: readonly PromptValue[]): string {
	const sections = new Map<string, string[]>([
		["tools", []],
		["tool-guidance", []],
		["skills", []],
		["documentation", []],
		["project-context", []],
		["environment", []],
		["additional-instructions", []],
	]);
	const skillTool = (["read", "bash"] as const).find((name) => inputs.selectedTools?.includes(name));
	if (skillTool) sections.get("skills")?.push(formatSkillsForPrompt(inputs.skills ?? [], skillTool).trim());
	sections.get("documentation")
		?.push(`Consult Pi or Tau documentation when the request concerns their usage or extension APIs.
Pi documentation:
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
- Examples: ${getExamplesPath()}
- Resolve docs/... and examples/... under those installed paths, not the working directory.
- Extensions: docs/extensions.md and examples/extensions/; themes: docs/themes.md; skills: docs/skills.md; prompt templates: docs/prompt-templates.md; TUI: docs/tui.md; keybindings: docs/keybindings.md; SDK: docs/sdk.md; providers: docs/custom-provider.md; models: docs/models.md; packages: docs/packages.md; environment: docs/environment-variables.md.
- Read the relevant documentation and follow related Markdown references before implementing Pi integrations.`);
	sections
		.get("project-context")
		?.push(
			...(inputs.contextFiles ?? []).map(
				(file) =>
					`<project_instructions path=${JSON.stringify(file.path)}>\n${file.content}\n</project_instructions>`,
			),
		);
	sections.get("environment")?.push(`Working directory: ${inputs.cwd}`);
	sections.get("additional-instructions")?.push(
		inputs.customPrompt ?? "",
		inputs.appendSystemPrompt ?? "",
		...Object.entries(inputs.sections ?? {})
			.sort(([a], [b]) => a.localeCompare(b, "en"))
			.map(([key, text]) => `<${key}>\n${text}\n</${key}>`),
	);
	for (const value of values) {
		const content = sections.get(value.section) ?? [];
		content.push(value.text);
		sections.set(value.section, content);
	}
	return [
		FIXED_INSTRUCTIONS,
		...[...sections].flatMap(([name, pieces]) => {
			const text = pieces.filter((piece) => piece.trim()).join("\n\n");
			return text ? [`<${name}>\n${text}\n</${name}>`] : [];
		}),
	].join("\n\n");
}

export function renderUpdate(values: readonly PromptValue[]): string {
	return values
		.map(
			(value) =>
				`<context-update source=${JSON.stringify(value.key)}>\nThis replaces the previous information for this source.\n${value.text || "This source no longer supplies instructions."}\n</context-update>`,
		)
		.join("\n\n");
}
