import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Markdown } from "@earendil-works/pi-tui";

export default function tauHelpExtension(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("tau-help", (message, _options, _theme) => {
		if (typeof message.content !== "string") return undefined;
		return new Markdown(message.content, 0, 0, getMarkdownTheme());
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
