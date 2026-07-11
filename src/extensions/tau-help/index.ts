import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Markdown, type Component, visibleWidth } from "@earendil-works/pi-tui";

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
