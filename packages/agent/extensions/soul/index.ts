import { getDocsPath, getExamplesPath, getReadmePath, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emitTauEvent } from "../../shared/events.ts";
import { collectPromptSources } from "../../shared/prompt-contributions.ts";
import { FIXED_INSTRUCTIONS } from "./prompt.ts";

const CAPTURE_TYPE = "tau.soul.capture";

const DOCUMENTATION = `Consult Pi or Tau documentation when the request concerns their usage or extension APIs.
Pi documentation:
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
- Examples: ${getExamplesPath()}
- Resolve docs/... and examples/... under those installed paths, not the working directory.
- Extensions: docs/extensions.md and examples/extensions/; themes: docs/themes.md; skills: docs/skills.md; prompt templates: docs/prompt-templates.md; TUI: docs/tui.md; keybindings: docs/keybindings.md; SDK: docs/sdk.md; providers: docs/custom-provider.md; models: docs/models.md; packages: docs/packages.md; environment: docs/environment-variables.md.
- Read the relevant documentation and follow related Markdown references before implementing Pi integrations.`;

export default function soulExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const options = event.systemPromptOptions;

		// Sources that refresh on compaction are read once per compaction epoch and saved on the branch.
		const branch = ctx.sessionManager.getBranch();
		let epochStart = 0;
		branch.forEach((entry, index) => {
			if (entry.type === "compaction") epochStart = index + 1;
		});
		let captured: Record<string, string> = {};
		for (const entry of branch.slice(epochStart)) {
			if (entry.type === "custom" && entry.customType === CAPTURE_TYPE)
				captured = entry.data as Record<string, string>;
		}
		const sources = collectPromptSources(pi);
		const missing = sources.filter((source) => source.refresh === "compaction" && !(source.key in captured));
		if (missing.length > 0) {
			const read = await Promise.all(missing.map(async (source) => [source.key, await source.read(ctx)] as const));
			captured = { ...captured, ...Object.fromEntries(read) };
			pi.appendEntry(CAPTURE_TYPE, captured);
		}

		const active = pi.getActiveTools();
		const guidance = [
			...new Set([
				...(active.includes("bash") ? ["Use bash for file operations like ls, rg, find."] : []),
				...active.flatMap((name) => options.toolGuidelines[name] ?? []),
				...options.promptGuidelines,
			]),
		]
			.map((rule) => `- ${rule}`)
			.join("\n");

		const sections = new Map<string, string[]>();
		const add = (section: string, text: string) => {
			if (text.trim()) sections.set(section, [...(sections.get(section) ?? []), text]);
		};
		add("documentation", DOCUMENTATION);
		add("tool-guidance", guidance);
		if (options.customPrompt) add("additional-instructions", options.customPrompt);
		for (const source of sources) {
			add(source.section, source.refresh === "append" ? await source.read(ctx) : (captured[source.key] ?? ""));
		}

		// Pi diffs these sections against the prompt already in the transcript and appends a patch only for
		// sections whose text changed, so unchanged sections keep the cached prefix.
		options.customPrompt = FIXED_INSTRUCTIONS;
		for (const name of [...sections.keys()].sort()) options.sections[name] = (sections.get(name) ?? []).join("\n\n");
		emitTauEvent(pi, "tau:prompt.snapshot", { text: event.systemPrompt });
	});
}
