import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { INFO_SEPARATOR, SlotEditor, type EditorSlots } from "@shanepadgett/tau-tui";
import { onTauEventImmediately, type TauAgentEvents } from "../../shared/events.ts";

type SlotItem = TauAgentEvents["tau:editor-slot"];

export default function editorBorderExtension(pi: ExtensionAPI): void {
	const items = new Map<string, SlotItem>();
	let activeCtx: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;

	function slotText(ctx: ExtensionContext, slot: SlotItem["slot"]): string {
		const texts = [...items.values()]
			.filter((item) => item.slot === slot)
			.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id))
			.map((item) => item.text);
		return texts.length ? ctx.ui.theme.fg("muted", texts.join(ctx.ui.theme.fg("dim", INFO_SEPARATOR))) : "";
	}

	onTauEventImmediately(pi, "editor-border.slots", "tau:editor-slot", (item) => {
		const key = `${item.slot}:${item.id}`;
		const text = item.text?.trim();
		if (!text) {
			if (items.delete(key)) requestRender?.();
			return;
		}
		items.set(key, { ...item, text });
		requestRender?.();
	});

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			requestRender = () => tui.requestRender();
			return new SlotEditor(tui, theme, keybindings, (): EditorSlots => {
				const current = activeCtx ?? ctx;
				return {
					topLeft: slotText(current, "top-left"),
					topCenter: slotText(current, "top-center"),
					topRight: slotText(current, "top-right"),
					bottomLeft: slotText(current, "bottom-left"),
					bottomRight: slotText(current, "bottom-right"),
				};
			});
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		requestRender = undefined;
		activeCtx = undefined;
		items.clear();
		ctx.ui.setEditorComponent(undefined);
	});
}
