import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Key } from "@earendil-works/pi-tui";

const MODE_STATE_TYPE = "tau.mode";
const DEFAULT_MODE = "act";
const MODE_ORDER = ["plan", "act", "review", "debug"] as const;
const PLAN_TOOLS = ["read", "grep", "find", "ls", "webresearch"];
const DEFAULT_TOOLS = ["read", "grep", "ls", "webresearch", "bash", "apply_patch"];

type ModeName = (typeof MODE_ORDER)[number];

interface ModeConfig {
	label: string;
	description: string;
	preferredModels: ModeModelCandidate[];
	fallbackThinkingLevel: ThinkingLevel;
	guidance: string;
}

interface ModeModelCandidate {
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
}

interface ModeState {
	name: ModeName;
	candidateIndex?: number;
}

const QUALITY_MODELS: ModeModelCandidate[] = [
	{ provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "xhigh" },
	{ provider: "anthropic", model: "claude-opus-4-8", thinkingLevel: "xhigh" },
	{ provider: "github-copilot", model: "gemini-3.1-pro-preview", thinkingLevel: "xhigh" },
];

const ACT_MODELS: ModeModelCandidate[] = [
	{ provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "low" },
	{ provider: "anthropic", model: "claude-opus-4-8", thinkingLevel: "medium" },
	{ provider: "github-copilot", model: "gemini-3.1-pro-preview", thinkingLevel: "low" },
];

const MODES: Record<ModeName, ModeConfig> = {
	plan: {
		label: "Plan",
		description: "Read-only exploration and plan writing",
		preferredModels: QUALITY_MODELS,
		fallbackThinkingLevel: "xhigh",
		guidance: `## Tau Mode: Plan

- Inspect and plan only. Do not edit files or run mutating commands.
- Build a numbered plan with files, risks, and checks.
- Ask for go-ahead before implementation.`,
	},
	act: {
		label: "Act",
		description: "Focused implementation",
		preferredModels: ACT_MODELS,
		fallbackThinkingLevel: "low",
		guidance: `## Tau Mode: Act

- Make focused changes. Follow the existing plan if there is one.
- Keep scope tight. Stop and explain if the plan is wrong.
- Run the cheapest relevant check after non-trivial changes.`,
	},
	review: {
		label: "Review",
		description: "Code review and risk finding",
		preferredModels: QUALITY_MODELS,
		fallbackThinkingLevel: "xhigh",
		guidance: `## Tau Mode: Review

- Review only unless the user explicitly asks for edits.
- Prioritize real risks: correctness, data loss, security, maintainability.
- Cite exact files/lines when possible. Skip praise and filler.`,
	},
	debug: {
		label: "Debug",
		description: "Reproduce, isolate, fix",
		preferredModels: QUALITY_MODELS,
		fallbackThinkingLevel: "xhigh",
		guidance: `## Tau Mode: Debug

- Reproduce or narrow the failure before changing code.
- Prefer the smallest fix that explains the symptom.
- Leave a narrow check that fails if the bug comes back.`,
	},
};

export function registerModes(pi: ExtensionAPI): void {
	let activeMode: ModeName | undefined;
	let activeCandidateIndex: number | undefined;
	let previousTools: string[] | undefined;

	async function applyMode(
		name: ModeName,
		ctx: ExtensionContext,
		options: { persist?: boolean; quiet?: boolean; fromRestore?: boolean } = {},
	): Promise<void> {
		const config = MODES[name];
		const enteringPlan = name === "plan" && activeMode !== "plan";
		const leavingPlan = activeMode === "plan" && name !== "plan";

		if (enteringPlan && !options.fromRestore) previousTools = pi.getActiveTools();

		activeCandidateIndex = await applyPreferredModel(
			pi,
			ctx,
			config,
			options.fromRestore ? (activeCandidateIndex ?? 0) : 0,
			options.quiet === true,
		);

		if (leavingPlan) {
			pi.setActiveTools(filterKnownTools(pi, previousTools ?? DEFAULT_TOOLS));
			previousTools = undefined;
		}

		if (name === "plan") {
			pi.setActiveTools(filterKnownTools(pi, PLAN_TOOLS));
		}

		activeMode = name;
		updateStatus(ctx, activeMode);

		if (options.persist !== false) persistMode(pi, activeMode, activeCandidateIndex);
		if (!options.quiet) ctx.ui.notify(`Mode: ${config.label}`, "info");
	}

	pi.registerCommand("mode", {
		description: "Switch Tau mode",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const value = prefix.trimStart().toLowerCase();
			if (/\s/.test(value)) return null;
			const items = MODE_ORDER.filter((name) => name.startsWith(value)).map((name) => ({
				value: name,
				label: name,
				description: MODES[name].description,
			}));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const trimmed = args.trim();
			if (!trimmed) {
				await pickMode(ctx, (name) => applyMode(name, ctx));
				return;
			}

			const name = parseMode(trimmed);
			if (!name) {
				ctx.ui.notify(`Unknown mode "${trimmed}". Use: ${MODE_ORDER.join(", ")}`, "error");
				return;
			}

			await applyMode(name, ctx);
		},
	});

	pi.registerShortcut(Key.ctrlShift("m"), {
		description: "Cycle Tau mode",
		handler: async (ctx) => {
			await applyMode(nextMode(activeMode), ctx);
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!activeMode) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${MODES[activeMode].guidance}` };
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (!activeMode || activeCandidateIndex === undefined || !shouldFallback(event.status)) return;

		const config = MODES[activeMode];
		const nextIndex = await applyPreferredModel(pi, ctx, config, activeCandidateIndex + 1, true);
		if (nextIndex === undefined) {
			activeCandidateIndex = undefined;
			persistMode(pi, activeMode, activeCandidateIndex);
			return;
		}
		if (nextIndex === activeCandidateIndex) return;

		activeCandidateIndex = nextIndex;
		persistMode(pi, activeMode, activeCandidateIndex);
		const next = config.preferredModels[nextIndex];
		if (next) {
			ctx.ui.notify(
				`Mode ${activeMode}: provider returned ${event.status}; using ${next.provider}/${next.model} next turn.`,
				"warning",
			);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const restored = latestModeState(ctx.sessionManager.getEntries());
		if (!restored) {
			await applyMode(DEFAULT_MODE, ctx, { persist: false, quiet: true });
			return;
		}

		activeCandidateIndex = restored.candidateIndex;
		await applyMode(restored.name, ctx, { persist: false, quiet: true, fromRestore: true });
	});
}

async function pickMode(ctx: ExtensionCommandContext, apply: (name: ModeName) => Promise<void>): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(`Usage: /mode <${MODE_ORDER.join("|")}>`, "error");
		return;
	}

	const selected = await ctx.ui.select(
		"Tau mode",
		MODE_ORDER.map((name) => `${name} — ${MODES[name].description}`),
	);
	if (!selected) return;

	const name = parseMode(selected.split(" ", 1)[0] ?? "");
	if (name) await apply(name);
}

async function applyPreferredModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: ModeConfig,
	startIndex: number,
	quiet: boolean,
): Promise<number | undefined> {
	for (let index = startIndex; index < config.preferredModels.length; index++) {
		const candidate = config.preferredModels[index];
		if (!candidate) continue;

		const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
		if (!model) continue;

		if (await pi.setModel(model)) {
			pi.setThinkingLevel(candidate.thinkingLevel);
			return index;
		}
	}

	pi.setThinkingLevel(config.fallbackThinkingLevel);
	if (!quiet) ctx.ui.notify("No preferred mode model available. Keeping current model.", "warning");
	return undefined;
}

function updateStatus(ctx: ExtensionContext, activeMode: ModeName | undefined): void {
	ctx.ui.setStatus("tau-mode", activeMode ? ctx.ui.theme.fg("accent", `mode:${activeMode}`) : undefined);
}

function persistMode(pi: ExtensionAPI, name: ModeName, candidateIndex: number | undefined): void {
	pi.appendEntry<ModeState>(MODE_STATE_TYPE, { name, candidateIndex });
}

function latestModeState(entries: readonly SessionEntry[]): ModeState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== MODE_STATE_TYPE) continue;
		const state = readModeState(entry.data);
		if (state) return state;
	}
	return undefined;
}

function readModeState(data: unknown): ModeState | undefined {
	if (!data || typeof data !== "object") return undefined;

	const record = data as Record<string, unknown>;
	const name = typeof record.name === "string" ? parseMode(record.name) : undefined;
	if (!name) return undefined;

	return {
		name,
		candidateIndex: typeof record.candidateIndex === "number" ? record.candidateIndex : undefined,
	};
}

function shouldFallback(status: number): boolean {
	return status === 402 || status === 403 || status === 429 || status >= 500;
}

function filterKnownTools(pi: ExtensionAPI, names: readonly string[]): string[] {
	return filterKnownToolNames(names, new Set(pi.getAllTools().map((tool) => tool.name)));
}

function filterKnownToolNames(names: readonly string[], known: ReadonlySet<string>): string[] {
	return names.filter((name) => known.has(name));
}

function nextMode(current: ModeName | undefined): ModeName {
	if (!current) return MODE_ORDER[0];
	return MODE_ORDER[(MODE_ORDER.indexOf(current) + 1) % MODE_ORDER.length] ?? MODE_ORDER[0];
}

function parseMode(value: string): ModeName | undefined {
	const name = value.trim().toLowerCase();
	return isModeName(name) ? name : undefined;
}

function isModeName(value: string): value is ModeName {
	return (MODE_ORDER as readonly string[]).includes(value);
}

// ponytail: self-check covers pure mode logic; Pi runtime behavior is exercised by /mode.
function demo(): void {
	if (parseMode(" PLAN ") !== "plan") throw new Error("mode parse failed");
	if (nextMode("debug") !== "plan") throw new Error("mode cycle failed");
	const filtered = filterKnownToolNames(["read", "missing", "ls"], new Set(["read", "ls"]));
	if (filtered.join(",") !== "read,ls") throw new Error("tool filter failed");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/extensions/core/src/modes/index.ts")) demo();
