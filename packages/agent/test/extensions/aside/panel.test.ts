import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type KeybindingsManager, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AsideResultPanel, AsideWidget, type AsideResult } from "../../../extensions/aside/panel.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

beforeAll(() => initTheme());

describe("aside UI", () => {
	it("renders a bounded thinking widget between horizontal borders", () => {
		const lines = new AsideWidget(theme, "why ".repeat(1_000)).render(24);

		expect(lines.length).toBeLessThanOrEqual(9);
		expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
		expect(lines[0]).toBe("─".repeat(24));
		expect(lines.at(-1)).toBe("─".repeat(24));
		expect(lines.join("\n")).toContain("Aside · Thinking…");
		expect(lines.join("\n")).not.toContain("answer");
	});

	it("scrolls a bounded Markdown result and closes through configured bindings", () => {
		const requestRender = vi.fn();
		const tui = { terminal: { rows: 20 }, requestRender } as unknown as TUI;
		const keys = {
			matches: (data: string, binding: string) =>
				(data === "down" && binding === "tui.select.down") ||
				(data === "enter" && binding === "tui.select.confirm") ||
				(data === "escape" && binding === "tui.select.cancel"),
		} as unknown as KeybindingsManager;
		const done = vi.fn();
		const result: AsideResult = {
			question: "What changed?",
			answer: Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join("\n\n"),
			context: "Current conversation branch",
		};
		const panel = new AsideResultPanel(tui, theme, keys, result, done);

		const lines = panel.render(48);
		expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
		expect(lines.join("\n")).toContain("What changed?");
		panel.handleInput("down");
		expect(requestRender).toHaveBeenCalledOnce();
		panel.handleInput("enter");
		panel.handleInput("escape");
		expect(done).toHaveBeenCalledTimes(2);
	});
});
