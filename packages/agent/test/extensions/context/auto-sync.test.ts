import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	runContextSync: vi.fn(),
	validateContextCatalog: vi.fn(),
	formatContextValidationFailure: vi.fn(),
	loadRepoStatus: vi.fn(),
	loadTauExtensionSettings: vi.fn(),
	findProjectRoot: vi.fn(),
}));

vi.mock("../../../extensions/context/sync.ts", () => ({
	runContextSync: mocks.runContextSync,
}));

vi.mock("../../../extensions/context/validation.ts", () => ({
	validateContextCatalog: mocks.validateContextCatalog,
	formatContextValidationFailure: mocks.formatContextValidationFailure,
}));

vi.mock("../../../shared/git.ts", () => ({
	createGitRunner: () => ({ cwd: "/tmp", run: async () => "" }),
	loadRepoStatus: mocks.loadRepoStatus,
}));

vi.mock("../../../shared/settings/load.ts", () => ({
	loadTauExtensionSettings: mocks.loadTauExtensionSettings,
}));

vi.mock("../../../extensions/context/definitions.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../extensions/context/definitions.ts")>();
	return {
		...actual,
		findProjectRoot: mocks.findProjectRoot,
	};
});

import contextExtension from "../../../extensions/context/index.ts";

afterEach(() => {
	vi.clearAllMocks();
});

function harness(): {
	messages: unknown[];
	notifies: Array<{ message: string; level?: string }>;
	emit: (name: string, event?: unknown, ctx?: Record<string, unknown>) => Promise<void>;
} {
	const messages: unknown[] = [];
	const notifies: Array<{ message: string; level?: string }> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void | Promise<void>>>();
	let activeTools: string[] = [];
	const pi = {
		events: createEventBus(),
		registerTool() {},
		registerCommand() {},
		sendMessage(message: unknown) {
			messages.push(message);
		},
		on(name: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		getThinkingLevel() {
			return "medium";
		},
	} as unknown as ExtensionAPI;
	contextExtension(pi);
	return {
		messages,
		notifies,
		async emit(name, event = {}, ctx: Record<string, unknown> = {}) {
			const baseCtx = {
				cwd: "/repo",
				isProjectTrusted: () => true,
				ui: {
					notify(message: string, level?: string) {
						notifies.push({ message, level });
					},
					setStatus() {},
				},
				...ctx,
			};
			for (const handler of handlers.get(name) ?? []) await handler(event, baseCtx);
		},
	};
}

describe("context validation auto-sync", () => {
	it("spawns context-sync once per unresolved failure fingerprint", async () => {
		mocks.loadTauExtensionSettings.mockResolvedValue({
			sync: { enabled: true, automation: true },
			validation: { enabled: true, ignoreGlobs: [] },
		});
		mocks.findProjectRoot.mockResolvedValue("/repo");
		mocks.loadRepoStatus.mockResolvedValue({ root: "/repo", fileCount: 1 });
		mocks.validateContextCatalog.mockResolvedValue({ stale: [], uncovered: ["src/a.ts"] });
		mocks.formatContextValidationFailure.mockReturnValue("failure-A");
		// Pre-check + post-check both still fail with the same fingerprint.
		mocks.runContextSync.mockResolvedValue({
			outcome: "failed",
			summary: "still broken",
			reason: "nope",
			changedContextFiles: [],
		});

		const state = harness();
		await state.emit("agent_start");
		await state.emit("agent_end", { messages: [] });
		await state.emit("agent_end", { messages: [] });

		expect(mocks.runContextSync).toHaveBeenCalledOnce();
		expect(state.messages).toEqual([]);
		expect(state.notifies.some((item) => item.message.includes("running context-sync"))).toBe(true);
		expect(state.notifies.some((item) => item.message === "still broken")).toBe(true);
	});

	it("clears fingerprint after successful sync and can spawn again on a new failure", async () => {
		mocks.loadTauExtensionSettings.mockResolvedValue({
			sync: { enabled: true, automation: true },
			validation: { enabled: true, ignoreGlobs: [] },
		});
		mocks.findProjectRoot.mockResolvedValue("/repo");
		mocks.loadRepoStatus.mockResolvedValue({ root: "/repo", fileCount: 1 });
		mocks.validateContextCatalog
			.mockResolvedValueOnce({ stale: [], uncovered: ["src/a.ts"] }) // pre-sync A
			.mockResolvedValueOnce({ stale: [], uncovered: [] }) // post-sync A clean
			.mockResolvedValueOnce({ stale: [], uncovered: ["src/b.ts"] }) // pre-sync B
			.mockResolvedValueOnce({ stale: [], uncovered: [] }); // post-sync B clean
		mocks.formatContextValidationFailure.mockImplementation((result: { uncovered: string[] }) =>
			result.uncovered[0] === "src/a.ts"
				? "failure-A"
				: result.uncovered[0] === "src/b.ts"
					? "failure-B"
					: undefined,
		);
		mocks.runContextSync
			.mockResolvedValueOnce({
				outcome: "applied",
				summary: "fixed",
				reason: "ok",
				changedContextFiles: [".pi/contexts/code/a.toml"],
			})
			.mockResolvedValueOnce({
				outcome: "applied",
				summary: "fixed again",
				reason: "ok",
				changedContextFiles: [".pi/contexts/code/b.toml"],
			});

		const state = harness();
		await state.emit("agent_start");
		await state.emit("agent_end", { messages: [] });
		await state.emit("agent_end", { messages: [] });

		expect(mocks.runContextSync).toHaveBeenCalledTimes(2);
		expect(state.notifies.map((item) => item.message)).toEqual([
			"Context catalog validation failed; running context-sync",
			"fixed",
			"Context catalog validation failed; running context-sync",
			"fixed again",
		]);
	});

	it("skips aborted turns and disabled validation", async () => {
		mocks.loadTauExtensionSettings.mockResolvedValue({
			sync: { enabled: true, automation: true },
			validation: { enabled: false, ignoreGlobs: [] },
		});
		const state = harness();
		await state.emit("agent_start");
		await state.emit("agent_end", {
			messages: [{ role: "assistant", stopReason: "aborted" }],
		});
		await state.emit("agent_end", { messages: [] });
		expect(mocks.runContextSync).not.toHaveBeenCalled();
	});

	it("does not auto-spawn when sync master switch is off", async () => {
		mocks.loadTauExtensionSettings.mockResolvedValue({
			sync: { enabled: false, automation: true },
			validation: { enabled: true, ignoreGlobs: [] },
		});
		mocks.findProjectRoot.mockResolvedValue("/repo");
		mocks.loadRepoStatus.mockResolvedValue({ root: "/repo", fileCount: 1 });
		mocks.validateContextCatalog.mockResolvedValue({ stale: [], uncovered: ["src/a.ts"] });
		mocks.formatContextValidationFailure.mockReturnValue("failure-A");
		const state = harness();
		await state.emit("agent_start");
		await state.emit("agent_end", { messages: [] });
		expect(mocks.runContextSync).not.toHaveBeenCalled();
	});
});
