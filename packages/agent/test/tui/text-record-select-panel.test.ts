import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type TUI } from "@earendil-works/pi-tui";
import { createTextRecordSelectPanel, rawHint } from "@shanepadgett/tau-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => initTheme());

describe("text record select panel", () => {
	it("confirms destructive actions inline and keeps the cursor in place", async () => {
		const theme = {
			fg: (color: string, text: string) => (color === "accent" ? `[${text}]` : text),
			bold: (text: string) => text,
		} as unknown as Theme;
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		let items = ["one", "two", "three", "four"].map((text) => ({ id: text, text }));
		const done = vi.fn();
		const onConfirm = vi.fn(async (item: (typeof items)[number]) => {
			items = items.filter((candidate) => candidate.id !== item.id);
			return items;
		});
		const panel = createTextRecordSelectPanel(
			tui,
			theme,
			items,
			{
				title: "Records",
				path: "/records.jsonl",
				emptyMessage: "No records.",
				primaryLabel: "use",
				actions: [],
				expandActiveItem: false,
				destructiveAction: {
					id: "delete",
					key: "ctrl+d",
					hint: rawHint("ctrl+d", "delete"),
					confirmLabel: (item) => `Delete ${item.text}?`,
					runningLabel: "Deleting…",
					onConfirm,
					onError: vi.fn(),
				},
			},
			done,
		);

		panel.handleInput?.("\x1b[B");
		panel.handleInput?.("\x1b[B");
		panel.handleInput?.("\x04");

		let output = panel.render(80).join("\n");
		expect(output).toContain("Delete three?");
		expect(output).toContain("[three]");
		expect(done).not.toHaveBeenCalled();

		panel.handleInput?.("\r");
		await Promise.resolve();
		await Promise.resolve();

		output = panel.render(80).join("\n");
		expect(output).toContain("3 total");
		expect(output).toContain("[four]");

		panel.handleInput?.("\x04");
		expect(panel.render(80).join("\n")).toContain("Delete four?");
		panel.handleInput?.("\r");
		await Promise.resolve();
		await Promise.resolve();

		output = panel.render(80).join("\n");
		expect(onConfirm.mock.calls.map(([item]) => item.text)).toEqual(["three", "four"]);
		expect(output).toContain("[two]");
		expect(output).not.toContain("[one]");
	});
});
