import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentsPanel } from "../../../extensions/subagent/panel.ts";

beforeAll(() => initTheme());

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

describe("subagent panel", () => {
	it("uses the shared panel and list to toggle session state", () => {
		const requestRender = vi.fn();
		const onApply = vi.fn();
		const done = vi.fn();
		const panel = createAgentsPanel(
			{ requestRender } as unknown as TUI,
			theme,
			[{ id: "review", disabled: false, configured: false }],
			onApply,
			done,
		);

		const initial = panel.render(80).join("\n");
		expect(initial).toContain("Subagents");
		expect(initial).toContain("Changes apply to this session.");
		expect(initial).toContain("review  enabled");
		expect(initial).toContain("toggle");
		expect(initial).toContain("apply");

		panel.handleInput?.(" ");

		expect(onApply).not.toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalledOnce();
		expect(panel.render(80).join("\n")).toContain("review  disabled");

		panel.handleInput?.("\r");
		expect(onApply).toHaveBeenCalledWith(["review"]);
		expect(done).toHaveBeenCalledOnce();
	});

	it("keeps settings-controlled agents locked", () => {
		const onApply = vi.fn();
		const panel = createAgentsPanel(
			{ requestRender() {} } as unknown as TUI,
			theme,
			[{ id: "scout", disabled: true, configured: true }],
			onApply,
			() => {},
		);

		expect(panel.render(80).join("\n")).toContain("scout  disabled by Tau settings");
		panel.handleInput?.(" ");
		expect(onApply).not.toHaveBeenCalled();
	});
});
