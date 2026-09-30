// fallow-ignore-file unused-file -- manually invoked codemode benchmark; command documented in pi-0.99-alignment.md
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
const outputPath = resolve(cwd, "docs/plans/pi-0.99-codemode-results.json");
const agentDir = mkdtempSync(resolve(tmpdir(), "tau-codemode-"));
const model = getModel("openai-codex", "gpt-6-luna");
if (!model) throw new Error("Luna is absent from the catalog");
const tasks = [
	{
		id: "parallel-outlines",
		prompt: "Inspect packages/agent/extensions/soul/index.ts, packages/agent/extensions/tool-loader/index.ts, and packages/agent/extensions/compaction/index.ts. List each file's top-level declarations with their line ranges. Use outline with includePrivate true. Keep the answer short and include all three files.",
	},
	{
		id: "filtered-declarations",
		prompt: "Use outline with includePrivate true on packages/agent/extensions/cache-diagnostics/index.ts, packages/agent/extensions/silent-command-runner/index.ts, and packages/agent/extensions/tool-approval/index.ts. Report only the top-level function declarations whose names contain 'format', 'fingerprint', or 'review', with file and line ranges. Do not read entire file bodies. Include a no-match statement for any file with no matches.",
	},
	{
		id: "dependency-summary",
		prompt: "Find direct internal imports of packages/agent/extensions/soul/index.ts, packages/agent/extensions/tool-loader/index.ts, and packages/agent/extensions/compaction/index.ts using deps with depth 1. Report the common internal dependencies shared by any two files and each file's unique internal imports. Exclude external npm packages. Keep the answer short.",
	},
];
const results = [];
for (let repeat = 1; repeat <= 2; repeat++) {
	for (const task of tasks) {
		// Alternate order to reduce systematic cache-warmup bias.
		for (const mode of repeat === 1 ? ["direct", "codemode"] : ["codemode", "direct"]) {
			const settings = SettingsManager.inMemory({
				defaultTools: mode === "codemode" ? ["read", "+codemode"] : ["read"],
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
			const timer = setTimeout(() => void session.abort(), 120_000);
			try {
				await session.bindExtensions({});
				await session.prompt(task.prompt);
				const assistants = session.messages.filter((message) => message.role === "assistant");
				const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
				for (const message of session.messages) {
					if (!message.usage) continue;
					for (const key of ["input", "output", "cacheRead", "cacheWrite"]) usage[key] += message.usage[key];
					usage.cost += message.usage.cost.total;
				}
				const result = {
					task: task.id, repeat, mode, elapsedMs: Date.now() - start,
					requests: requestCount, usage, calls, wire,
					stopReason: assistants.at(-1)?.stopReason,
					error: assistants.at(-1)?.errorMessage,
					answer: session.getLastAssistantText(),
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
