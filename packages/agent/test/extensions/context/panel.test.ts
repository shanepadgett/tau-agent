import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ContextEntry } from "../../../extensions/context/definitions.ts";
import { ContextPanel, ContextSyncStatusPanel } from "../../../extensions/context/panel.ts";

beforeAll(() => initTheme());

function entry(read: string[], outline: string[], references: string[]): ContextEntry {
	return {
		id: "code/source/all",
		tab: "code",
		concept: "source",
		conceptName: "Source",
		conceptDescription: "Source files",
		name: "all",
		description: "All source files",
		read,
		outline,
		references,
		path: ".pi/contexts/code/source.toml",
	};
}

function panel(value: ContextEntry): ContextPanel {
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	const tui = {
		terminal: { columns: 100, rows: 40 },
		requestRender: vi.fn(),
	} as unknown as TUI;
	return new ContextPanel(tui, theme, [value], [], () => {});
}

describe("context panel", () => {
	it("labels each loading mode", () => {
		const output = panel(entry(["AGENTS.md"], ["src/runtime.ts"], ["src/fetch.ts"]))
			.render(100)
			.join("\n");
		expect(output).toContain("0 selected · 1 read · 1 outline · 1 references");
		expect(output).toContain("read • AGENTS.md");
		expect(output).toContain("outline • src/runtime.ts");
		expect(output).toContain("reference • src/fetch.ts");
	});

	it("renders a reference-only entry", () => {
		const output = panel(entry([], [], ["src/fetch.ts"]))
			.render(100)
			.join("\n");
		expect(output).toContain("0 selected · 0 read · 0 outline · 1 references");
		expect(output).toContain("reference • src/fetch.ts");
	});

	it("renders bounded context-sync progress", () => {
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const status = new ContextSyncStatusPanel(tui, theme, "Inspecting repository context");
		status.update("first\nsecond\nthird\nfourth\nfifth\nsixth");
		const lines = status.render(30);

		expect(lines.join("\n")).toContain("Context sync");
		expect(lines.join("\n")).toContain("3 earlier lines omitted");
		expect(lines.join("\n")).not.toContain("first");
		expect(lines.join("\n")).toContain("sixth");
		expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
		status.dispose();
	});
});
