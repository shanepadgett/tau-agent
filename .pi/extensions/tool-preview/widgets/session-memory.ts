import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, type TUI } from "@earendil-works/pi-tui";
import {
	createSessionMemoryWidget,
	type SessionMemoryTab,
	type SessionMemoryWidgetView,
} from "../../../../packages/agent/extensions/session-memory/widget.ts";

const VIEW: SessionMemoryWidgetView = {
	goal: "Ship bounded session memory without losing intent or expensive findings.",
	objective: "Build the production extension and replace the preview renderer.",
	checkpoint: 4,
	activeTokens: 62_000,
	updatedAt: Date.now(),
	tasks: [
		"Build canonical state and checkpoint transitions",
		"Wire required-gate projection",
		"Cut over session-memory surfaces",
	],
	carry: [
		{
			id: "required-gate",
			text: "Required checkpoints block execution while tool definitions stay stable.",
			bornAtCheckpoint: 4,
		},
		{ id: "carry-span", text: "New findings get one complete checkpoint span.", bornAtCheckpoint: 4 },
	],
	durable: [
		{ id: "goal-approval", text: "Goal changes require user approval." },
		{ id: "cache-stability", text: "Cache stability is a correctness requirement." },
	],
	readFiles: ["packages/agent/extensions/session-memory/index.ts", "packages/agent/extensions/session-memory/tool.ts"],
	outlineFiles: ["packages/agent/extensions/session-memory/projection.ts"],
	deferFiles: [
		{
			path: "packages/agent/extensions/session-memory/widget.ts",
			reason: "renderer is complete",
			relevantWhen: "visual tests fail",
		},
	],
};

export function createSessionMemoryPreviewWidget(_tui: TUI, _cwd: string, theme: Theme): Component {
	return new SessionMemoryPreview(_tui, theme);
}

class SessionMemoryPreview implements Component {
	private readonly widgets: readonly Component[];

	constructor(tui: TUI, theme: Theme) {
		this.widgets = (["tasks", "memories", "files"] as const satisfies readonly SessionMemoryTab[]).map(
			(selectedTab) =>
				createSessionMemoryWidget(tui, theme, getKeybindings(), { view: VIEW, selectedTab, onClose: () => {} }),
		);
	}

	render(width: number): string[] {
		return this.widgets.flatMap((widget, index) =>
			index === 0 ? widget.render(width) : ["", ...widget.render(width)],
		);
	}

	invalidate(): void {
		for (const widget of this.widgets) widget.invalidate();
	}
}
