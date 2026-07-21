import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type ExecResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	loadTauExtensionSettings: vi.fn(),
}));

vi.mock("../../../shared/settings/load.ts", () => ({
	loadTauExtensionSettings: mocks.loadTauExtensionSettings,
}));

import silentCommandRunnerExtension from "../../../extensions/silent-command-runner/index.ts";

interface SentMessage {
	message: unknown;
	options: unknown;
}

interface Harness {
	exec: ReturnType<typeof vi.fn>;
	messages: SentMessage[];
	notifications: Array<{ message: string; type?: string }>;
	attentionEvents: Array<{ name: string; data: unknown }>;
	userMessages: unknown[];
	emit(name: string, event?: unknown): Promise<void>;
}

const roots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<{ root: string; file: string }> {
	const root = await mkdtemp(join(tmpdir(), "tau-silent-command-runner-"));
	roots.push(root);
	const file = join(root, "src", "index.ts");
	await mkdir(join(root, ".git"));
	await mkdir(join(root, "src"));
	await writeFile(file, "export const value = 0;\n");
	await utimes(file, new Date(1000), new Date(1000));
	return { root, file };
}

function result(code: number): ExecResult {
	return { code, killed: false, stdout: code === 0 ? "ok" : "", stderr: code === 0 ? "" : "failed" };
}

function harness(root: string, execute: (...args: unknown[]) => Promise<ExecResult>): Harness {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void | Promise<void>>>();
	const messages: SentMessage[] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const attentionEvents: Array<{ name: string; data: unknown }> = [];
	const userMessages: unknown[] = [];
	const events = createEventBus();
	events.on("tau:attention.hold.acquire", (data) => attentionEvents.push({ name: "acquire", data }));
	events.on("tau:attention.hold.release", (data) => attentionEvents.push({ name: "release", data }));
	const exec = vi.fn(execute);
	const pi = {
		events,
		exec,
		registerMessageRenderer() {},
		sendMessage(message: unknown, options: unknown) {
			messages.push({ message, options });
		},
		sendUserMessage(message: unknown) {
			userMessages.push(message);
		},
		on(name: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	silentCommandRunnerExtension(pi);

	return {
		exec,
		messages,
		notifications,
		attentionEvents,
		userMessages,
		async emit(name, event = {}) {
			const ctx = {
				cwd: root,
				ui: {
					notify(message: string, type?: string) {
						notifications.push({ message, type });
					},
				},
			};
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

function configure(): void {
	mocks.loadTauExtensionSettings.mockResolvedValue({
		enabled: true,
		maxOutputBytes: 51200,
		commands: [{ name: "check", command: "npm test", includeGlobs: ["**/*.ts"] }],
	});
}

async function initialize(state: Harness): Promise<void> {
	await state.emit("session_start");
	await state.emit("agent_start");
}

async function edit(file: string, clock: number, content = `export const value = ${clock};\n`): Promise<void> {
	await writeFile(file, content);
	await utimes(file, new Date(clock), new Date(clock));
}

describe("silent command runner lifecycle", () => {
	it("runs a failed command from agent_end and queues one custom follow-up", async () => {
		configure();
		const { root, file } = await project();
		let clock = 2000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const state = harness(root, async () => result(1));
		await initialize(state);
		clock = 3000;
		await edit(file, clock);

		await state.emit("agent_end", { messages: [] });

		expect(state.exec).toHaveBeenCalledOnce();
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]?.options).toEqual({ deliverAs: "followUp" });
		expect(state.messages[0]?.options).not.toHaveProperty("triggerTurn");
		expect(state.userMessages).toEqual([]);
	});

	it("refreshes the baseline for a no-edit repair continuation", async () => {
		configure();
		const { root, file } = await project();
		let clock = 2000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const state = harness(root, async () => result(1));
		await initialize(state);
		clock = 3000;
		await edit(file, clock);
		await state.emit("agent_end", { messages: [] });

		clock = 4000;
		await state.emit("agent_start");
		await state.emit("agent_end", { messages: [] });

		expect(state.exec).toHaveBeenCalledOnce();
		expect(state.messages).toHaveLength(1);
	});

	it("reruns the command after a matching repair edit", async () => {
		configure();
		const { root, file } = await project();
		let clock = 2000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const state = harness(root, vi.fn().mockResolvedValueOnce(result(1)).mockResolvedValueOnce(result(0)));
		await initialize(state);
		clock = 3000;
		await edit(file, clock);
		await state.emit("agent_end", { messages: [] });

		clock = 4000;
		await state.emit("agent_start");
		clock = 5000;
		await edit(file, clock, "export const value = 2;\n");
		await state.emit("agent_end", { messages: [] });

		expect(state.exec).toHaveBeenCalledTimes(2);
		expect(state.messages).toHaveLength(1);
		expect(state.notifications).toContainEqual({ message: "silent-command-runner: passed check", type: "info" });
	});

	it("keeps passing command output out of model context", async () => {
		configure();
		const { root, file } = await project();
		let clock = 2000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const state = harness(root, async () => result(0));
		await initialize(state);
		clock = 3000;
		await edit(file, clock);

		await state.emit("agent_end", { messages: [] });

		expect(state.messages).toEqual([]);
		expect(state.userMessages).toEqual([]);
		expect(state.notifications).toContainEqual({ message: "silent-command-runner: passed check", type: "info" });
	});

	it("notifies once and settles when command execution throws", async () => {
		configure();
		const { root, file } = await project();
		let clock = 2000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const state = harness(root, async () => {
			throw new Error("spawn failed");
		});
		await initialize(state);
		clock = 3000;
		await edit(file, clock);

		await state.emit("agent_end", { messages: [] });

		expect(state.notifications.filter(({ type }) => type === "error")).toEqual([
			{ message: "silent-command-runner: spawn failed", type: "error" },
		]);
		expect(state.messages).toEqual([]);
	});

	it("skips checks for an aborted run", async () => {
		configure();
		const { root, file } = await project();
		let clock = 2000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const state = harness(root, async () => result(1));
		await initialize(state);
		clock = 3000;
		await edit(file, clock);

		await state.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });

		expect(state.exec).not.toHaveBeenCalled();
		expect(state.messages).toEqual([]);
	});

	it("holds attention across failure and repair until final settlement", async () => {
		configure();
		const { root, file } = await project();
		let clock = 2000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const state = harness(root, async () => result(1));
		await initialize(state);
		clock = 3000;
		await edit(file, clock);
		await state.emit("agent_end", { messages: [] });

		clock = 4000;
		await state.emit("agent_start");
		expect(state.attentionEvents.map((event) => event.name)).toEqual(["acquire"]);
		await state.emit("agent_end", { messages: [] });
		await state.emit("agent_settled");

		expect(state.attentionEvents).toEqual([
			{ name: "acquire", data: { id: "silent-command-runner:1" } },
			{ name: "release", data: { id: "silent-command-runner:1", disposition: "notify" } },
		]);
	});

	it("aborts an active command during session shutdown", async () => {
		configure();
		const { root, file } = await project();
		let clock = 2000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		let finish: ((value: ExecResult) => void) | undefined;
		let signal: AbortSignal | undefined;
		const state = harness(
			root,
			async (_command, _args, options) =>
				new Promise<ExecResult>((resolve) => {
					signal = (options as { signal: AbortSignal }).signal;
					finish = resolve;
				}),
		);
		await initialize(state);
		clock = 3000;
		await edit(file, clock);
		const agentEnd = state.emit("agent_end", { messages: [] });
		await vi.waitFor(() => expect(state.exec).toHaveBeenCalledOnce());

		await state.emit("session_shutdown");

		expect(signal?.aborted).toBe(true);
		if (!finish) throw new Error("Command did not start");
		finish({ ...result(1), killed: true });
		await agentEnd;
		expect(state.exec).toHaveBeenCalledOnce();
		expect(state.messages).toEqual([]);
	});
});
