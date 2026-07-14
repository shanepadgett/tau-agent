import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Markdown, type Component, visibleWidth } from "@earendil-works/pi-tui";

const TAU_DOCS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs");
const TAU_DOCS_GUIDANCE = `Tau Agent documentation (read only when the user asks about Tau Agent, Rok, Tau extensions, Tau event APIs, harness behavior, or extending Tau Agent):
- Tau Agent docs: ${TAU_DOCS_PATH}
- When asked about: public events / external integration (docs/extending-tau-agent.md), custom subagents (docs/subagents.md), Tau TUI components (docs/tui.md)
- Resolve Tau docs/... under Tau Agent docs, not the current working directory
- When working on Tau topics, read the docs and follow .md cross-references before implementing
- Do not read Tau Agent docs for normal coding tasks`;

const TAU_SYMBOL = [
	"            %%%%%%%%#######*******+++++",
	"        @@%%%%%%%########*******+++++++",
	"      @@%%%%%%%########*******+++++++=",
	"     @%%%%%%%#######********+++++++==",
	"    %%%%%%%#######********+++++++===",
	"   %%           *******+",
	"               ******+++",
	"              *****++++",
	"              ***+++++",
	"             *+++++++",
	"            ++++++++=",
	"           ++++++===",
	"           ++++=====",
	"          +++=======       -:",
	"          +=======--------::",
	"          ======-------::::",
	"            ==-------::::",
	"               ----:::",
].join("\n");

class TauHelpMessage implements Component {
	private readonly markdown: Markdown;

	constructor(content: string, theme: ReturnType<typeof getMarkdownTheme>) {
		this.markdown = new Markdown(content, 0, 0, theme);
	}

	render(width: number): string[] {
		const symbolLines = TAU_SYMBOL.split("\n");
		const symbolWidth = Math.max(...symbolLines.map((line) => visibleWidth(line)));
		const padding = Math.max(0, Math.floor((width - symbolWidth) / 2));
		const symbol = symbolLines.map((line) => " ".repeat(padding) + line);
		return [...symbol, "", ...this.markdown.render(width)];
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}

export default function tauHelpExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${TAU_DOCS_GUIDANCE}`,
	}));

	pi.registerMessageRenderer("tau-help", (message, _options, _theme) => {
		if (typeof message.content !== "string") return undefined;
		return new TauHelpMessage(message.content, getMarkdownTheme());
	});

	pi.registerCommand("tau-help", {
		description: "Show the Tau extension and prompt guide",
		handler: async (_args, _ctx) => {
			const content = await readFile(join(dirname(fileURLToPath(import.meta.url)), "help.md"), "utf8");
			await pi.sendMessage(
				{
					customType: "tau-help",
					content,
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});
}
