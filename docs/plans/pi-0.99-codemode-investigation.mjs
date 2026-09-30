// fallow-ignore-file unused-file -- manually invoked codemode investigation benchmark; command documented in pi-0.99-alignment.md
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { getModel } from "../../node_modules/@earendil-works/pi-ai/dist/compat.js";

const cwd = fileURLToPath(new URL("../../", import.meta.url));
const outputPath = resolve(cwd, "docs/plans/pi-0.99-codemode-investigation-results.json");
const agentDir = mkdtempSync(resolve(tmpdir(), "tau-codemode-"));
const model = getModel("openai-codex", "gpt-6-luna");
if (!model) throw new Error("Luna is absent from the catalog");
const tasks = [{
    id: "side-call-model-routing",
    prompt: "Investigate how Tau extensions select models for side calls. Identify each entry point, trace its model-selection and request path, and report whether it stays on the session provider, can cross providers, or uses the session model directly. Cite file paths and declaration names. Be as efficient as possible.",
}];
const results = [];
for (let repeat = 1; repeat <= 1; repeat++) {
	for (const task of tasks) {
		// Two fresh sessions; only the codemode prompt adds encouragement.
		for (const mode of repeat === 1 ? ["direct", "codemode"] : ["codemode", "direct"]) {
			const settings = SettingsManager.inMemory({
				defaultTools: mode === "codemode" ? ["read", "grep", "find", "ls", "+codemode"] : ["read", "grep", "find", "ls"],
				codemode: { mode: "on" },
				compaction: { enabled: false },
				retry: { enabled: false },
				cacheWarming: "off",
			});
			const calls = [];
			const wire = [];
			let requestCount = 0;
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: settings,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				additionalExtensionPaths: [
					resolve(cwd, "packages/agent/extensions/codex-priority/index.ts"),
					resolve(cwd, "packages/agent/extensions/explore/index.ts"),
					resolve(cwd, "packages/agent/extensions/soul/index.ts"),
				],
				extensionFactories: [
					...(mode === "codemode" ? [createCodemodeExtension({ mode: "on", models: false })] : []),
					(pi) => {
						pi.on("tool_call", (event) => {
							calls.push({ name: event.toolName, input: event.input, parent: event.parentToolCallId });
						});
						pi.on("before_provider_request", (event) => {
							requestCount++;
							const payload = event.payload;
							wire.push({ serviceTier: payload.service_tier, toolNames: payload.tools?.map((tool) => tool.name) });
						});
					},
				],
			});
			await loader.reload();
			const runtime = await ModelRuntime.create({ refreshOnCreate: false });
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model,
				thinkingLevel: "medium",
				modelRuntime: runtime,
				settingsManager: settings,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(cwd),
			});
			const start = Date.now();
			const timer = setTimeout(() => void session.abort(), 300_000);
			try {
				await session.bindExtensions({});
				const prompt = task.prompt + (mode === "codemode" ? "\nPrefer codemode when it helps you complete this investigation efficiently." : "");
				await session.prompt(prompt);
				const assistants = session.messages.filter((message) => message.role === "assistant");
				const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
				for (const message of session.messages) {
					if (!message.usage) continue;
					for (const key of ["input", "output", "cacheRead", "cacheWrite"]) usage[key] += message.usage[key];
					usage.cost += message.usage.cost.total;
				}
				const result = {
					task: task.id, prompt, model: "openai-codex/gpt-6-luna", reasoning: "medium", repeat, mode, elapsedMs: Date.now() - start,
					requests: requestCount, usage, calls, wire,
					stopReason: assistants.at(-1)?.stopReason,
					error: assistants.at(-1)?.errorMessage,
					answer: session.getLastAssistantText(),
					transcript: session.messages,
					toolErrors: session.messages.filter((message) => message.role === "toolResult" && message.isError),
				};
				results.push(result);
				writeFileSync(outputPath, JSON.stringify(results, null, 2) + "\n");
				console.log(JSON.stringify({ task: task.id, repeat, mode, requests: requestCount, calls: calls.length, usage, stopReason: result.stopReason }));
			} finally {
				clearTimeout(timer);
				await session.extensionRunner.emit({ type: "session_shutdown" });
				session.dispose();
			}
		}
	}
}
