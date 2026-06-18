import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Key } from "@earendil-works/pi-tui";
import { setTauFooterItem } from "../../../../shared/events.ts";

const MODE_STATE_TYPE = "tau.mode";
const DEFAULT_MODE = "act";
const MODE_ORDER = ["plan", "act", "review", "debug"] as const;
const PLAN_TOOLS = ["read", "grep", "find", "ls"];
const NON_PLAN_TOOLS = ["read", "grep", "find", "ls", "bash"];

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
		description: "Complexity and stability review",
		preferredModels: QUALITY_MODELS,
		fallbackThinkingLevel: "xhigh",
		guidance: `## Tau Mode: Review

- Review only unless the user explicitly asks for edits.
- Hunt avoidable complexity and stability risk: deletion, simplification, dedupe, stdlib/native/internal reuse, and small refactors.
- Use concrete tags when useful: delete, shrink, dedupe, stdlib, native, internal, yagni, refactor.
- Mention correctness, data loss, security, or performance when complexity causes the risk; do not turn this into a broad audit unless asked.
- Cite exact files/lines when possible. Format findings as: path:Lx: <tag> <problem>. <smallest fix>.
- If clean, say: Lean already. Ship.`,
	},
	debug: {
		label: "Debug",
		description: "Reproduce, isolate, fix",
		preferredModels: QUALITY_MODELS,
		fallbackThinkingLevel: "xhigh",
		guidance: `## Tau Mode: Debug

- Reproduce or narrow the failure before changing code.
- Prefer the smallest fix that explains the symptom and reduces the bug surface.
- Simplify the failing path when directly related: remove duplicate branches, dead fallbacks, fragile custom logic, or confusing indirection.
- Use stdlib, native platform features, or existing internal utilities when they make the fix smaller or more stable.
- Small abstractions are allowed only when they remove duplication or make one current invariant obvious.
- Do not chase unrelated cleanup or broad redesign.
- Leave a narrow check that fails if the bug comes back.`,
	},
};

export function registerModes(pi: ExtensionAPI): void {
	let activeMode: ModeName | undefined;
	let activeCandidateIndex: number | undefined;
	let nextTurnMode: ModeName | undefined;
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

		if (name === "plan") {
			pi.setActiveTools(filterKnownTools(pi, PLAN_TOOLS));
		} else {
			pi.setActiveTools(
				filterKnownTools(
					pi,
					ensureTools(leavingPlan ? (previousTools ?? []) : pi.getActiveTools(), NON_PLAN_TOOLS),
				),
			);
			if (leavingPlan) previousTools = undefined;
		}

		activeMode = name;
		updateStatus(ctx, activeMode);
		updateFooter(pi, activeMode);

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
			const trimmed = args.trim();
			if (!trimmed) {
				await ctx.waitForIdle();
				await pickMode(ctx, (name) => applyMode(name, ctx));
				return;
			}

			const command = parseModeCommand(args);
			if (!command) {
				ctx.ui.notify(`Unknown mode "${trimmed}". Use: ${MODE_ORDER.join(", ")}`, "error");
				return;
			}

			await runModeCommand(command.name, command.prompt, ctx);
		},
	});

	for (const name of MODE_ORDER) {
		const commandName = name === "debug" ? "debug-issue" : name;
		pi.registerCommand(commandName, {
			description: `Switch to ${name} mode; with text, submit it in that mode`,
			handler: async (args, ctx) => {
				await runModeCommand(name, commandPrompt(args), ctx);
			},
		});
	}

	pi.registerCommand("audit", {
		description: "Run a repo-wide complexity/stability audit",
		handler: async (args, ctx) => {
			runOneShotCommand(ctx, "audit", buildAuditPrompt(commandPrompt(args)));
		},
	});

	pi.registerCommand("debt", {
		description: "Harvest lean shortcut markers into a debt ledger",
		handler: async (args, ctx) => {
			runOneShotCommand(ctx, "debt", buildDebtPrompt(commandPrompt(args)));
		},
	});

	pi.registerShortcut(Key.ctrlShift("m"), {
		description: "Cycle Tau mode",
		handler: async (ctx) => {
			await applyMode(nextMode(activeMode), ctx);
		},
	});

	pi.on("before_agent_start", (event) => {
		const mode = nextTurnMode ?? activeMode;
		nextTurnMode = undefined;
		if (!mode) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${MODES[mode].guidance}` };
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

	async function runModeCommand(
		name: ModeName,
		prompt: string | undefined,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (prompt && !ctx.isIdle()) {
			ctx.ui.notify("Agent is busy", "warning");
			return;
		}

		await ctx.waitForIdle();
		await applyMode(name, ctx);
		if (prompt) pi.sendUserMessage(prompt);
	}

	function runOneShotCommand(ctx: ExtensionCommandContext, type: string, prompt: string): void {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Agent is busy", "warning");
			return;
		}

		nextTurnMode = "review";
		pi.sendMessage({ customType: `tau.${type}`, content: prompt, display: false }, { triggerTurn: true });
	}
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

function updateFooter(pi: ExtensionAPI, activeMode: ModeName | undefined): void {
	setTauFooterItem(pi, {
		id: "tau-mode",
		text: activeMode ? `mode:${activeMode}` : undefined,
		priority: 100,
	});
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

function ensureTools(names: readonly string[], required: readonly string[]): string[] {
	return [...new Set([...names, ...required])];
}

function nextMode(current: ModeName | undefined): ModeName {
	if (!current) return MODE_ORDER[0];
	return MODE_ORDER[(MODE_ORDER.indexOf(current) + 1) % MODE_ORDER.length] ?? MODE_ORDER[0];
}

function parseMode(value: string): ModeName | undefined {
	const name = value.trim().toLowerCase();
	return isModeName(name) ? name : undefined;
}

function parseModeCommand(value: string): { name: ModeName; prompt: string | undefined } | undefined {
	const match = value.trimStart().match(/^(\S+)(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;

	const name = parseMode(match[1] ?? "");
	if (!name) return undefined;

	return { name, prompt: commandPrompt(match[2] ?? "") };
}

function commandPrompt(args: string): string | undefined {
	const prompt = args.trim();
	return prompt ? prompt : undefined;
}

function buildAuditPrompt(focus: string | undefined): string {
	return [
		"Run a repo-wide complexity/stability audit. Report only unless user explicitly asks for edits.",
		...(focus ? [`Focus/scope: ${focus}`] : []),
		"Scan the repo tree, not just the diff. Skip .git, node_modules, dist, build, coverage, generated output, references, and agent cache/session/temp dirs. Rank biggest simplification/stability wins first.",
		"Tags: delete, shrink, dedupe, stdlib, native, internal, yagni, refactor.",
		"Hunt: dead code, stale config, speculative features, unused flexibility, duplicated logic, single-implementation interfaces, factories with one product, delegate-only wrappers, files/layers that do not earn their keep, hand-rolled stdlib, dependencies/platform code replacing native behavior, internal utilities not reused.",
		"Format: <tag> <problem>. <smallest fix>. [path]",
		"Mention correctness/security/perf only when complexity causes the risk.",
		"End with net removable lines/deps/duplicated paths only if you can estimate honestly. If clean: Lean already. Ship.",
	].join("\n\n");
}

function buildDebtPrompt(focus: string | undefined): string {
	return [
		"Harvest lean shortcut markers into a debt ledger. Report only unless user asks to persist.",
		...(focus ? [`Focus/scope: ${focus}`] : []),
		"Scan for comment markers: lean: and legacy ponytail:. Include line-comment prefixes (#, //) and block/doc comment prefixes if present in this stack.",
		"Skip .git, node_modules, dist, build, coverage, generated output, and agent cache/session/temp dirs.",
		"One row per marker, grouped by file: <file>:<line> — <marker> <what was simplified>. ceiling: <limit>. upgrade: <trigger/path>.",
		"Tag no-trigger when the marker lacks a concrete revisit trigger or upgrade path. Tag legacy for ponytail: markers. Tag weak when the marker is vague.",
		"End with: <N> markers, <M> no-trigger, <L> legacy.",
		"If none: No lean debt. Clean ledger.",
	].join("\n\n");
}

function isModeName(value: string): value is ModeName {
	return (MODE_ORDER as readonly string[]).includes(value);
}

// lean: self-check covers pure mode logic; Pi runtime behavior needs the host command dispatcher.
function demo(): void {
	if (parseMode(" PLAN ") !== "plan") throw new Error("mode parse failed");
	const command = parseModeCommand(" review   current diff ");
	if (command?.name !== "review" || command.prompt !== "current diff") throw new Error("mode command parse failed");
	if (parseModeCommand("nope") !== undefined) throw new Error("bad mode command parsed");
	if (commandPrompt("  failing test ") !== "failing test") throw new Error("command prompt parse failed");
	if (!buildAuditPrompt("src").includes("Focus/scope: src")) throw new Error("audit focus missing");
	if (!buildAuditPrompt(undefined).includes("dedupe")) throw new Error("audit tags missing");
	if (!buildDebtPrompt(undefined).includes("legacy ponytail:")) throw new Error("debt legacy marker missing");
	if (nextMode("debug") !== "plan") throw new Error("mode cycle failed");
	const filtered = filterKnownToolNames(["read", "missing", "ls"], new Set(["read", "ls"]));
	if (filtered.join(",") !== "read,ls") throw new Error("tool filter failed");
	const ensured = ensureTools(["custom_tool", "read"], ["read", "grep", "bash"]);
	if (ensured.join(",") !== "custom_tool,read,grep,bash") throw new Error("tool ensure failed");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/extensions/core/src/modes/index.ts")) demo();
