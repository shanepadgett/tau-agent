import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { setContinuityRowsVisible } from "../../shared/continuity-visibility.ts";
import { registerCheckpointTool } from "./checkpoint.ts";
import { projectContextMessages } from "./messages.ts";
import continuitySettings from "./settings.ts";

export default function continuityExtension(pi: ExtensionAPI): void {
	registerCheckpointTool(pi);
	pi.on("session_start", async (_event, ctx) => {
		const settings = await loadTauExtensionSettings(ctx, continuitySettings);
		setContinuityRowsVisible(settings.showToolRows);
	});
	pi.on("session_shutdown", () => {
		setContinuityRowsVisible(false);
	});
	pi.on("context", (event, ctx) => ({
		messages: projectContextMessages(event.messages, ctx.sessionManager.buildContextEntries()),
	}));
}
