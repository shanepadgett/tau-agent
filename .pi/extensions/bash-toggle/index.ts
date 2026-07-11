import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setTauFooterItem } from "../../../packages/agent/shared/events.ts";

const COMMAND = "bash";
const FOOTER_ID = "bash-toggle";
const STATE_TYPE = "bash-toggle";
const BASH_ALTERNATE_TOOLS = ["grep", "find", "ls"];

interface BashToggleState {
	disabled: boolean;
}

export default function bashToggle(pi: ExtensionAPI): void {
	let disabled = false;

	function applyTools(): void {
		const activeTools = pi.getActiveTools();
		if (disabled) {
			pi.setActiveTools([...new Set([...activeTools.filter((tool) => tool !== "bash"), ...BASH_ALTERNATE_TOOLS])]);
			return;
		}

		if (!activeTools.includes("bash")) pi.setActiveTools([...activeTools, "bash"]);
	}

	function publishFooter(): void {
		setTauFooterItem(pi, {
			id: FOOTER_ID,
			priority: 20,
			text: disabled ? "bash off" : undefined,
		});
	}

	function persistState(): void {
		pi.appendEntry<BashToggleState>(STATE_TYPE, { disabled });
	}

	function restoreState(ctx: ExtensionContext): void {
		let saved: BashToggleState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
			const data = entry.data;
			if (data && typeof data === "object" && "disabled" in data && typeof data.disabled === "boolean") {
				saved = { disabled: data.disabled };
			}
		}

		disabled = saved?.disabled ?? false;
		applyTools();
		publishFooter();
	}

	function notifyState(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.notify(`Bash ${disabled ? "disabled" : "enabled"}`, "info");
	}

	function setDisabled(ctx: ExtensionContext, next: boolean): void {
		disabled = next;
		applyTools();
		publishFooter();
		persistState();
		notifyState(ctx);
	}

	pi.registerCommand(COMMAND, {
		description: "Toggle agent bash tool",
		handler: async (_args, ctx) => {
			setDisabled(ctx, !disabled);
		},
	});

	pi.on("session_start", (event, ctx) => {
		restoreState(ctx);
		if (event.reason === "reload") notifyState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("tool_call", (event) => {
		if (!disabled || event.toolName !== "bash") return;
		return { block: true, reason: "Bash disabled by /bash" };
	});

	pi.on("session_shutdown", () => {
		setTauFooterItem(pi, { id: FOOTER_ID, text: undefined });
	});
}
