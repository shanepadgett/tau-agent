import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type KeybindingsManager, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionMemoryWidget, type SessionMemoryWidgetView } from "../../../extensions/session-memory/widget.ts";

const theme = {
	fg(_name: string, text: string) {
		return text;
	},
	bg(_name: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
} as unknown as Theme;

const view: SessionMemoryWidgetView = {
	longTermGoal: "Ship bounded session memory",
	checkpoint: 3,
	activeTokens: 62_000,
	updatedAt: Date.parse("2026-07-29T12:00:00.000Z"),
	tasks: ["Active task", "Later task"],
	shortTermMemories: [{ id: "hidden-id", text: "Short-term statement", bornAtCheckpoint: 3 }],
	longTermMemories: [{ id: "other-hidden-id", text: "Long-term statement" }],
	readFiles: ["active.ts"],
	outlineFiles: ["related.ts"],
	deferFiles: [{ path: "later.ts", reason: "inactive", relevantWhen: "tests fail" }],
};

beforeAll(() => initTheme());

function widget(selectedTab: "tasks" | "memories" | "files" = "tasks", onClose = () => {}) {
	const tui = { requestRender: vi.fn() } as unknown as TUI;
	const keys = {
		matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "\x1b",
	} as unknown as KeybindingsManager;
	return { component: createSessionMemoryWidget(tui, theme, keys, { view, selectedTab, onClose }), tui };
}

afterEach(() => vi.useRealTimers());

describe("session-memory widget", () => {
	it("renders each selected tab from the same immutable view without memory IDs", () => {
		vi.useFakeTimers();
		vi.setSystemTime("2026-07-29T12:02:00.000Z");
		const tasks = widget("tasks").component.render(80).join("\n");
		const memories = widget("memories").component.render(80).join("\n");
		const files = widget("files").component.render(80).join("\n");
		expect(tasks).toContain("LONG-TERM GOAL  Ship bounded session memory");
		expect(tasks).toContain("● Active task");
		expect(tasks).toContain("updated 2m ago");
		expect(tasks).toContain("Tab/←/→");
		expect(tasks).toContain("switch tab");
		expect(tasks).toContain("escape/ctrl+c");
		expect(tasks).toContain("close");
		expect(tasks).toContain("╭");
		expect(memories).toContain("Short-term statement");
		expect(memories).toContain("Long-term statement");
		expect(memories).not.toContain("hidden-id");
		expect(files).toContain("▸ active.ts");
		expect(files).toContain("when tests fail");
	});

	it("navigates tabs with arrows, closes with Escape, and fits narrow widths", () => {
		const onClose = vi.fn();
		const { component, tui } = widget("tasks", onClose);
		expect(component.render(80).join("\n")).toContain("● Active task");
		component.handleInput?.("\x1b[C");
		expect(component.render(80).join("\n")).toContain("Short-term statement");
		component.handleInput?.("\x1b[D");
		expect(component.render(80).join("\n")).toContain("● Active task");
		expect(tui.requestRender).toHaveBeenCalledTimes(2);
		component.handleInput?.("\x1b");
		expect(onClose).toHaveBeenCalledOnce();

		const lines = widget("files").component.render(24);
		expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
	});
});
