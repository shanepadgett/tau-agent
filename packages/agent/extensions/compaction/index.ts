import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { registerNativeCompaction } from "./native.ts";
import { registerSelfCompaction } from "./self-compact.ts";
import settingsSpec from "./settings.ts";

export default function compactionExtension(pi: ExtensionAPI): void {
	const unsubscribe = pi.on("session_start", async (_event, ctx) => {
		const settings = await loadTauExtensionSettings(ctx, settingsSpec);
		unsubscribe();
		if (settings.selfCompact.enabled) registerSelfCompaction(pi, ctx, settings);
		else registerNativeCompaction(pi);
	});
}
