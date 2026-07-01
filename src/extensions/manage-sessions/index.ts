import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showSessionManager } from "./manager-ui.ts";

export default function manageSessionsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("manage-sessions", {
		description: "Manage saved sessions in the TUI",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			if (ctx.mode !== "tui") {
				ctx.ui.notify("Session manager requires TUI mode.", "error");
				return;
			}

			await showSessionManager(ctx);
		},
	});
}
