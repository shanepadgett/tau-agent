import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showSessionManager } from "./manager-ui.ts";
import { archiveSession, deleteSessionFile } from "./sessions.ts";

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

	pi.registerCommand("sweep", {
		description: "Archive or delete the current session after starting a new one",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			if (!ctx.hasUI) {
				ctx.ui.notify("Sweep requires interactive UI.", "error");
				return;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("Current session is not persisted.", "error");
				return;
			}

			const choice = await ctx.ui.select("Sweep current session:", ["Archive", "Delete"]);
			if (choice !== "Archive" && choice !== "Delete") return;

			const confirmed = await ctx.ui.confirm(`${choice} this session?`, "Will launch a new session.");
			if (!confirmed) return;

			await ctx.newSession({
				parentSession: sessionFile,
				withSession: async (newCtx) => {
					try {
						if (choice === "Archive") await archiveSession(sessionFile);
						else await deleteSessionFile(sessionFile);

						newCtx.ui.notify(`Session ${choice.toLowerCase()}d.`, "info");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						newCtx.ui.notify(`Sweep failed: ${message}`, "error");
					}
				},
			});
		},
	});
}
