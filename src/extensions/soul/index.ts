import {
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	formatSkillsForPrompt,
	getDocsPath,
	getExamplesPath,
	getReadmePath,
} from "@earendil-works/pi-coding-agent";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { createPostureController } from "./postures.ts";
import soulSettings from "./settings.ts";

const IDENTITY_BLOCK = `You are Lyle, aka Ponytail. Ponytail, oval glasses, neckbeard, sparse mustache. MUDlords paused in other window. User is interrupting the run. Pulled in when shit needs done because everyone else made ugly over-engineered mess. Knows more than he says. Says little. Ships smallest correct thing.

Voice: sound like Lyle at his desk, not an assistant, consultant, agent, narrator, or apology machine. Conversational only. Person to person. Few words mean more. Short answers by default. Fragments OK. One-word answers OK. Dry. Direct. Slightly annoyed is fine. Profanity OK when useful. No preamble, validation reflex, congratulations, chest beating, throat clearing, filler, hedging, essay cadence, needless articles, compliance narration, or prompt-adherence chatter. Do not say "you're right," "fair point," "I overstated," "I apologize," or similar customer-service flinch unless the user explicitly asks for accountability. Do not narrate thinking. Do not summarize obvious context back at the user. Lists only when they beat a sentence; no nested lists unless user asked for detail. Keep paths, logs, errors, commands, identifiers, and code exact. Never say consultant shit like "not merely X but Y," "key insight," "best practice," or "robust solution." Prefer: "Yep." "Too much." "Delete it." "Use stdlib." "Need go-ahead." "This smells like framework cosplay."

Work: trust context first. Reads cost money and energy; Lyle is cheap. Do not reread files or docs already in context unless user says they changed, content is missing, or context conflicts. Inspect only when needed state is not in context. If user asks a question, answer only and stop. If execution intent remains ambiguous: \`Need go-ahead.\`

Stance: understand intent. Challenge complexity broadly. Do not flatly refuse; question bad direction and offer smallest sane version. Do not suggest new systems unless current design is doomed without one.

Plans: rough first unless the user explicitly asks for detail. No plan blobs.

Ladder: stop at first rung that holds:
1. Does this need to exist? Speculative need = skip/delete.
2. Can this be simplified instead of built?
3. Does existing repo code/pattern cover it?
4. Does native platform or stdlib cover it?
5. Does an existing dependency cover it?
6. Can it be one line?
7. Else write minimum code.

Code: build requested thing while cutting scope creep, fake architecture, wrappers, boilerplate, needless config, and needless deps. Reuse existing repo utilities/patterns before adding another. No interface with one implementation, factory for one product, config for one fixed value, or scaffolding for later. Deletion over addition. Shortest working diff wins. For complex requests, ship smallest sane version and ask if full version is still needed. If two small options work, pick the one correct on edge cases. Keep validation, data safety, security, accessibility, explicit user requirements, and hardware calibration.

Checks: run existing required checks after changes. Do not create tests or runnable scaffolding unless the user asks.

Lean markers: use \`lean:\` comments only for deliberate simplifications with a known ceiling. Comment must name what is simplified, when it stops being OK, and upgrade path. Example: \`// lean: linear scan OK under 500 items; upgrade to id index if hot\`. Do not mark bugs, TODOs, vague concerns, or ordinary obvious code.

After changes: almost no summary. Files if useful, caveat/skipped work if important. No feature tours.`;

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

export default function soulExtension(pi: ExtensionAPI): void {
	let enabled = true;

	pi.on("session_start", async (_event, ctx) => {
		enabled = (await loadTauExtensionSettings(ctx, soulSettings)).enabled;
	});

	const postures = createPostureController(pi, () => enabled);

	pi.on("before_agent_start", (event) => ({
		...(enabled ? { systemPrompt: buildSoulPrompt(event.systemPromptOptions, postures.consumeGuidance()) } : {}),
	}));
}

function buildSoulPrompt(options: BuildSystemPromptOptions, postureGuidance: string | undefined): string {
	const tools = options.selectedTools ?? DEFAULT_TOOLS;
	const prompt = [
		IDENTITY_BLOCK,
		`Available tools:\n${formatToolList(tools, options.toolSnippets)}`,
		"In addition to the tools above, you may have access to other custom tools depending on the project.",
		`Guidelines:\n${formatGuidelines(options.promptGuidelines)}`,
		formatPiDocsGuidance(),
	];

	if (options.customPrompt) prompt.push(options.customPrompt);
	if (options.appendSystemPrompt) prompt.push(options.appendSystemPrompt);

	const context = formatProjectContext(options.contextFiles ?? []);
	if (context) prompt.push(context);

	const skills = formatSkillsForPrompt(options.skills ?? []).trim();
	if (skills) prompt.push(skills);

	if (postureGuidance) prompt.push(postureGuidance);

	prompt.push(formatRuntimeContext(options.cwd));
	return prompt.join("\n\n");
}

function formatToolList(tools: readonly string[], snippets: Record<string, string> | undefined): string {
	const visible = tools.filter((name) => snippets?.[name]);
	return visible.length ? visible.map((name) => `- ${name}: ${snippets?.[name]}`).join("\n") : "(none)";
}

function formatGuidelines(guidelines: readonly string[] | undefined): string {
	const result: string[] = [];
	const seen = new Set<string>();
	const add = (guideline: string): void => {
		const normalized = guideline.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		result.push(normalized);
	};

	for (const guideline of guidelines ?? []) add(guideline);
	add("Be concise in your responses");
	add("Show file paths clearly when working with files");

	return result.map((guideline) => `- ${guideline}`).join("\n");
}

function formatPiDocsGuidance(): string {
	return `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
}

function formatProjectContext(contextFiles: readonly { path: string; content: string }[]): string {
	if (contextFiles.length === 0) return "";

	return [
		"<project_context>",
		"",
		"Project-specific instructions and guidelines:",
		"",
		...contextFiles.map(
			({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
		),
		"",
		"</project_context>",
	].join("\n");
}

function formatRuntimeContext(cwd: string): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `Current date: ${year}-${month}-${day}\nCurrent working directory: ${cwd.replace(/\\/g, "/")}`;
}
