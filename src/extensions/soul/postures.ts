import { resolve, sep } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { setTauFooterItem } from "../../shared/events.ts";

const POSTURE_STATE_TYPE = "tau.posture";
const DEFAULT_POSTURE = "act";
const POSTURE_ORDER = ["plan", "act", "review", "debug"] as const;
const SWITCH_POSTURE_TOOL = "switch_posture";
const PLAN_WRITE_DIR = "docs/plans";
const PLAN_TOOLS = ["read", "grep", "find", "ls", "write", "edit", SWITCH_POSTURE_TOOL];
const NON_PLAN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", SWITCH_POSTURE_TOOL];

type PostureName = (typeof POSTURE_ORDER)[number];

interface PostureConfig {
	label: string;
	description: string;
	preferredModels: readonly ModelCandidate[];
	thinkingLevel: ThinkingLevel;
	guidance: string;
}

interface ModelCandidate {
	provider: string;
	model: string;
}

interface PostureState {
	name: PostureName;
	candidateIndex?: number;
}

export interface PostureController {
	consumeGuidance(): string | undefined;
}

const POSTURE_MODELS: readonly ModelCandidate[] = [
	{ provider: "openai-codex", model: "gpt-5.5" },
	{ provider: "anthropic", model: "claude-opus-4-8" },
	{ provider: "github-copilot", model: "gemini-3.1-pro-preview" },
];

const POSTURES: Record<PostureName, PostureConfig> = {
	plan: {
		label: "Plan",
		description: "Read-only exploration and plan file writing",
		preferredModels: POSTURE_MODELS,
		thinkingLevel: "xhigh",
		guidance: `## Lyle Posture: Plan

- Read-only exploration, except write/edit may modify plan files under \`${PLAN_WRITE_DIR}/\`.
- No code edits, config edits, docs edits outside \`${PLAN_WRITE_DIR}/\`, or mutating commands.
- Start rough by default: 1–2 sentences naming the approach's bulk shape/silhouette, then pause for alignment.
- Skip the rough pass only when the user explicitly wants a detailed plan and the task has no meaningful ambiguity.
- After alignment or when detail is requested, produce a numbered plan with files, risks, and checks.
- Ask for go-ahead before implementation.`,
	},
	act: {
		label: "Act",
		description: "Focused implementation",
		preferredModels: POSTURE_MODELS,
		thinkingLevel: "medium",
		guidance: `## Lyle Posture: Act

- Implement the smallest correct change.
- Follow existing plan if present; stop if it is wrong.
- Run the cheapest relevant check after non-trivial changes.`,
	},
	review: {
		label: "Review",
		description: "Complexity and stability review",
		preferredModels: POSTURE_MODELS,
		thinkingLevel: "xhigh",
		guidance: `## Lyle Posture: Review

- Review only unless explicitly asked to edit.
- Find avoidable complexity and stability risk in the changed/relevant code.
- Use tags when useful: delete, shrink, dedupe, stdlib, native, internal, yagni, refactor.
- Mention correctness, data loss, security, or performance when complexity causes the risk.
- Format findings: path:Lx: <tag> <problem>. <smallest fix>.
- If clean: Lean already. Ship.`,
	},
	debug: {
		label: "Debug",
		description: "Reproduce, isolate, fix",
		preferredModels: POSTURE_MODELS,
		thinkingLevel: "xhigh",
		guidance: `## Lyle Posture: Debug

- Reproduce or narrow failure before changing code.
- Prefer the smallest causal fix.
- Simplify directly related failing paths when it reduces bug surface.
- Allow a small helper only when it removes duplication or makes one current invariant obvious.`,
	},
};

export function createPostureController(pi: ExtensionAPI, isEnabled: () => boolean): PostureController {
	let activePosture: PostureName | undefined;
	let activeCandidateIndex: number | undefined;
	let nextTurnPosture: PostureName | undefined;
	let previousTools: string[] | undefined;

	pi.registerTool({
		name: SWITCH_POSTURE_TOOL,
		label: "Switch Posture",
		description:
			"Ask the user to switch Lyle posture, then continue the requested work under the refreshed Soul prompt.",
		promptSnippet: "Request a posture switch when the user's latest intent fits another posture.",
		promptGuidelines: [
			"Use switch_posture before doing work when the user's latest intent clearly fits another Lyle posture.",
			"Use switch_posture with posture=act when in plan posture and the user asks to implement, edit, or change files.",
			"Use switch_posture with posture=plan when not in plan posture and the user asks to plan, design, explore, or discuss an edit/feature before implementation.",
			"Use switch_posture with posture=review when the user asks to review, audit, critique, or find problems.",
			"Use switch_posture with posture=debug when the user reports a bug, failure, error, broken behavior, or asks to reproduce/isolate/fix a failure.",
			"Do not use switch_posture when already in the matching posture or when intent is ambiguous.",
			"If switch_posture is denied, continue under the current posture.",
		],
		parameters: Type.Object({
			posture: StringEnum(POSTURE_ORDER),
			task: Type.String({
				description:
					"The exact work to continue after the posture switch. Include enough context that the next turn can proceed without asking the user to repeat themselves.",
			}),
			reason: Type.Optional(Type.String({ description: "Short reason for the requested posture switch." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isEnabled()) {
				return {
					content: [{ type: "text", text: "Soul is disabled. Continue without posture switch." }],
					details: {},
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Cannot switch posture without user approval UI." }],
					details: {},
				};
			}

			if (params.posture === activePosture) {
				return {
					content: [{ type: "text", text: `Already in ${params.posture} posture. Continue.` }],
					details: {},
				};
			}

			const reason = params.reason ? `\n\nReason: ${params.reason}` : "";
			const approved = await ctx.ui.confirm(
				`Switch to ${POSTURES[params.posture].label}?`,
				`The agent wants to continue in ${params.posture} posture.${reason}`,
			);

			if (!approved) {
				return {
					content: [{ type: "text", text: "Posture switch denied. Continue under current posture." }],
					details: {},
				};
			}

			await applyPosture(params.posture, ctx, { quiet: true });
			pi.sendMessage(
				{
					customType: "tau.posture.continue",
					content: params.task,
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);

			return {
				content: [
					{ type: "text", text: `Posture switched to ${params.posture}. Continuing with refreshed prompt.` },
				],
				details: {},
				terminate: true,
			};
		},
	});

	pi.on("tool_call", (event, ctx) => {
		if (activePosture !== "plan") return undefined;
		if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return undefined;
		if (isPlanWritePath(ctx.cwd, event.input.path)) return undefined;

		return {
			block: true,
			reason: `Plan posture may only write or edit under ${PLAN_WRITE_DIR}/`,
		};
	});

	async function applyPosture(
		name: PostureName,
		ctx: ExtensionContext,
		options: { persist?: boolean; quiet?: boolean; fromRestore?: boolean } = {},
	): Promise<void> {
		if (!isEnabled()) {
			activePosture = undefined;
			activeCandidateIndex = undefined;
			nextTurnPosture = undefined;
			previousTools = undefined;
			updateFooter(pi, undefined);
			return;
		}

		const config = POSTURES[name];
		const enteringPlan = name === "plan" && activePosture !== "plan";
		const leavingPlan = activePosture === "plan" && name !== "plan";

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

		activePosture = name;
		updateFooter(pi, activePosture);

		if (options.persist !== false) persistPosture(pi, activePosture, activeCandidateIndex);
		if (!options.quiet) ctx.ui.notify(`Posture: ${config.label}`, "info");
	}

	pi.registerCommand("posture", {
		description: "Switch Lyle posture",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const value = prefix.trimStart().toLowerCase();
			if (/\s/.test(value)) return null;
			const items = POSTURE_ORDER.filter((name) => name.startsWith(value)).map((name) => ({
				value: name,
				label: name,
				description: POSTURES[name].description,
			}));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			if (!isEnabled()) {
				ctx.ui.notify("Soul is disabled", "warning");
				return;
			}

			const trimmed = args.trim();
			if (!trimmed) {
				await ctx.waitForIdle();
				await pickPosture(ctx, (name) => applyPosture(name, ctx));
				return;
			}

			const command = parsePostureCommand(args);
			if (!command) {
				ctx.ui.notify(`Unknown posture "${trimmed}". Use: ${POSTURE_ORDER.join(", ")}`, "error");
				return;
			}

			await runPostureCommand(command.name, command.prompt, ctx);
		},
	});

	for (const name of POSTURE_ORDER) {
		pi.registerCommand(name, {
			description: `Switch to ${name} posture; with text, submit it in that posture`,
			handler: async (args, ctx) => {
				if (!isEnabled()) {
					ctx.ui.notify("Soul is disabled", "warning");
					return;
				}

				await runPostureCommand(name, commandPrompt(args), ctx);
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
		description: "Cycle Lyle posture",
		handler: async (ctx) => {
			await applyPosture(nextPosture(activePosture), ctx);
		},
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (!activePosture || activeCandidateIndex === undefined || !shouldFallback(event.status)) return;

		const config = POSTURES[activePosture];
		const nextIndex = await applyPreferredModel(pi, ctx, config, activeCandidateIndex + 1, true);
		if (nextIndex === undefined) {
			activeCandidateIndex = undefined;
			persistPosture(pi, activePosture, activeCandidateIndex);
			return;
		}
		if (nextIndex === activeCandidateIndex) return;

		activeCandidateIndex = nextIndex;
		persistPosture(pi, activePosture, activeCandidateIndex);
		const next = config.preferredModels[nextIndex];
		if (next) {
			ctx.ui.notify(
				`Posture ${activePosture}: provider returned ${event.status}; using ${next.provider}/${next.model} next turn.`,
				"warning",
			);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const restored = latestPostureState(ctx.sessionManager.getEntries());
		if (!restored) {
			await applyPosture(DEFAULT_POSTURE, ctx, { persist: false, quiet: true });
			if (_event.reason === "new") await pickPosture(ctx, (name) => applyPosture(name, ctx));
			return;
		}

		activeCandidateIndex = restored.candidateIndex;
		await applyPosture(restored.name, ctx, { persist: false, quiet: true, fromRestore: true });
	});

	async function runPostureCommand(
		name: PostureName,
		prompt: string | undefined,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (prompt && !ctx.isIdle()) {
			ctx.ui.notify("Agent is busy", "warning");
			return;
		}

		await ctx.waitForIdle();
		await applyPosture(name, ctx);
		if (prompt) pi.sendUserMessage(prompt);
	}

	function runOneShotCommand(ctx: ExtensionCommandContext, type: string, prompt: string): void {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Agent is busy", "warning");
			return;
		}

		nextTurnPosture = "review";
		pi.sendMessage({ customType: `tau.${type}`, content: prompt, display: false }, { triggerTurn: true });
	}

	return {
		consumeGuidance(): string | undefined {
			if (!isEnabled()) return undefined;
			const posture = nextTurnPosture ?? activePosture;
			nextTurnPosture = undefined;
			return posture ? POSTURES[posture].guidance : undefined;
		},
	};
}

async function pickPosture(ctx: ExtensionContext, apply: (name: PostureName) => Promise<void>): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(`Usage: /posture <${POSTURE_ORDER.join("|")}>`, "error");
		return;
	}

	const selected = await ctx.ui.select(
		"Lyle posture",
		POSTURE_ORDER.map((name) => `${name} — ${POSTURES[name].description}`),
	);
	if (!selected) return;

	const name = parsePosture(selected.split(" ", 1)[0] ?? "");
	if (name) await apply(name);
}

async function applyPreferredModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: PostureConfig,
	startIndex: number,
	quiet: boolean,
): Promise<number | undefined> {
	for (let index = startIndex; index < config.preferredModels.length; index++) {
		const candidate = config.preferredModels[index];
		if (!candidate) continue;

		const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
		if (!model) continue;

		if (await pi.setModel(model)) {
			pi.setThinkingLevel(config.thinkingLevel);
			return index;
		}
	}

	pi.setThinkingLevel(config.thinkingLevel);
	if (!quiet) ctx.ui.notify("No preferred posture model available. Keeping current model.", "warning");
	return undefined;
}

function updateFooter(pi: ExtensionAPI, activePosture: PostureName | undefined): void {
	setTauFooterItem(pi, {
		id: "tau-posture",
		text: activePosture,
		priority: 100,
	});
}

function persistPosture(pi: ExtensionAPI, name: PostureName, candidateIndex: number | undefined): void {
	pi.appendEntry<PostureState>(POSTURE_STATE_TYPE, { name, candidateIndex });
}

function latestPostureState(entries: readonly SessionEntry[]): PostureState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== POSTURE_STATE_TYPE) continue;
		const state = readPostureState(entry.data);
		if (state) return state;
	}
	return undefined;
}

function readPostureState(data: unknown): PostureState | undefined {
	if (!data || typeof data !== "object") return undefined;

	const record = data as Record<string, unknown>;
	const name = typeof record.name === "string" ? parsePosture(record.name) : undefined;
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

function isPlanWritePath(cwd: string, rawPath: string): boolean {
	const target = resolve(cwd, rawPath.trim().replace(/^@/, ""));
	const root = resolve(cwd, PLAN_WRITE_DIR);
	return target.startsWith(`${root}${sep}`);
}

function nextPosture(current: PostureName | undefined): PostureName {
	if (!current) return POSTURE_ORDER[0];
	return POSTURE_ORDER[(POSTURE_ORDER.indexOf(current) + 1) % POSTURE_ORDER.length] ?? POSTURE_ORDER[0];
}

function parsePosture(value: string): PostureName | undefined {
	const name = value.trim().toLowerCase();
	return isPostureName(name) ? name : undefined;
}

function parsePostureCommand(value: string): { name: PostureName; prompt: string | undefined } | undefined {
	const match = value.trimStart().match(/^(\S+)(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;

	const name = parsePosture(match[1] ?? "");
	if (!name) return undefined;

	return { name, prompt: commandPrompt(match[2] ?? "") };
}

function commandPrompt(args: string): string | undefined {
	const prompt = args.trim();
	return prompt ? prompt : undefined;
}

function buildAuditPrompt(focus: string | undefined): string {
	return [
		"Run a repo-wide over-engineering / avoidable-complexity audit, not a general correctness review. Report only unless user explicitly asks for edits.",
		...(focus ? [`Focus/scope: ${focus}`] : []),
		"Scan the repo tree, not just the diff. Skip .git, node_modules, dist, build, coverage, generated output, references, and agent cache/session/temp dirs. Rank biggest avoidable-complexity cuts first.",
		"Tags: delete, shrink, dedupe, stdlib, native, internal, yagni, refactor.",
		"Hunt: dead code, stale config, speculative features, unused flexibility, duplicated logic, single-implementation interfaces, factories with one product, delegate-only wrappers, files/layers that do not earn their keep, hand-rolled stdlib, dependencies/platform code replacing native behavior, internal utilities not reused.",
		"Format: <tag> <problem>. <smallest fix>. [path]",
		"Mention correctness/security/perf/stability only when avoidable complexity causes the risk.",
		"End with net removable lines/deps/duplicated paths only if you can estimate honestly. If clean: Lean already. Ship.",
	].join("\n\n");
}

function buildDebtPrompt(focus: string | undefined): string {
	return [
		"Harvest lean shortcut markers into a debt ledger. Report only unless user asks to persist.",
		...(focus ? [`Focus/scope: ${focus}`] : []),
		"Scan for comment markers: lean:. Include line-comment prefixes (#, //) and block/doc comment prefixes if present in this stack.",
		"Skip .git, node_modules, dist, build, coverage, generated output, and agent cache/session/temp dirs.",
		"One row per marker, grouped by file: <file>:<line> — lean: <shortcut>. OK while: <limit/condition>. upgrade: <specific fix> when <trigger>.",
		"Tag no-trigger when the marker lacks a concrete revisit trigger or upgrade path. Tag weak when the marker is vague or misses the shortcut, limit, trigger, or upgrade path.",
		"End with: <N> markers, <M> no-trigger, <W> weak.",
		"If none: No lean debt. Clean ledger.",
	].join("\n\n");
}

function isPostureName(value: string): value is PostureName {
	return (POSTURE_ORDER as readonly string[]).includes(value);
}
