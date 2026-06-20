import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
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
import { emitTauEvent, setTauFooterItem } from "../../shared/events.ts";
import { createGitRunner, loadRepoStatus, STAGED_PATCH_DIFF_ARGS } from "../../shared/git.ts";
import {
	SearchList,
	type SearchListConfig,
	type SearchListItem,
	type SearchListResult,
} from "../../shared/tui/search-list.ts";

const POSTURE_STATE_TYPE = "tau.posture";
const REVIEW_EVIDENCE_TYPE = "tau.review.evidence";
const MAX_REVIEW_DIFF_CHARS = 80_000;
const MAX_REVIEW_UNTRACKED_PREVIEW_BYTES = 12_000;
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
	thinkingLevel: ThinkingLevel;
	guidance: string;
}

interface PostureState {
	name: PostureName;
}

export interface PostureController {
	consumeGuidance(): string | undefined;
}

const POSTURES: Record<PostureName, PostureConfig> = {
	plan: {
		label: "Plan",
		description: "Read-only exploration and plan file writing",
		thinkingLevel: "xhigh",
		guidance: `## Lyle Posture: Plan

- Read-only exploration, except write/edit may modify plan files under \`${PLAN_WRITE_DIR}/\`.
- No code edits, config edits, docs edits outside \`${PLAN_WRITE_DIR}/\`, or mutating commands.
- Start rough by default: 1–2 sentences naming the approach's bulk shape/silhouette, then pause for alignment.
- Do not create a plan file for loose brainstorming.
- Once rough shape is aligned and decisions/details matter, write or update a plan file under \`${PLAN_WRITE_DIR}/\`.
- Treat the plan file as the planning surface: record decisions, steps, files, risks, checks, and open questions there.
- Keep chat short after a plan file exists: point to it, ask for review/feedback, then edit the file as decisions change.
- Ask for go-ahead before implementation.
- Plan posture cannot implement. Before any code/config/doc edit outside ${PLAN_WRITE_DIR}/, briefly state the plan, get explicit go-ahead unless already given, then call switch_posture with posture=act.
- If a write/edit outside ${PLAN_WRITE_DIR}/ is attempted in plan posture anyway, Tau may ask the user to switch to act and run that same tool call.`,
	},
	act: {
		label: "Act",
		description: "Focused implementation",
		thinkingLevel: "medium",
		guidance: `## Lyle Posture: Act

- Implement the smallest correct change.
- Follow existing plan if present; stop if it is wrong.
- Run the cheapest relevant check after non-trivial changes.`,
	},
	review: {
		label: "Review",
		description: "Complexity and stability review",
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
	let nextTurnPosture: PostureName | undefined;
	let previousTools: string[] | undefined;
	let pendingContinuation: string | undefined;

	pi.on("agent_end", () => {
		if (!pendingContinuation) return;

		const task = pendingContinuation;
		pendingContinuation = undefined;

		setTimeout(() => {
			pi.sendMessage(
				{ customType: "tau.posture.continue", content: task, display: false },
				{ deliverAs: "nextTurn" },
			);
			pi.sendUserMessage("Continue with the queued task.");
		}, 0);
	});

	pi.registerTool({
		name: SWITCH_POSTURE_TOOL,
		label: "Switch Posture",
		description:
			"Ask the user to switch Lyle posture, then continue the requested work under the refreshed Soul prompt.",
		promptSnippet: "Request a posture switch when the user's latest intent fits another posture.",
		promptGuidelines: [
			"Use switch_posture before doing work when the user's latest intent clearly fits another Lyle posture.",
			"Use switch_posture with posture=act when in plan posture and the user asks to implement, edit, or change files. Briefly state the plan and get explicit go-ahead first unless go-ahead was already given. Do not call write/edit for implementation before switching.",
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
				const placeholder = params.reason
					? `Agent asked: ${params.reason}. Optional reply to send back.`
					: "Optional. Tell the agent why, or hit Enter to skip.";
				const userReason = (await ctx.ui.input("Why not?", placeholder))?.trim();
				const text = userReason
					? `Posture switch denied. User reason: ${userReason}\n\nContinue under current posture.`
					: "Posture switch denied. Continue under current posture.";
				return {
					content: [{ type: "text", text }],
					details: {},
				};
			}

			await applyPosture(params.posture, ctx, { quiet: true });
			pendingContinuation = params.task;
			emitTauEvent(pi, "tau:posture.continuation_queued", { posture: params.posture });

			return {
				content: [{ type: "text", text: `Posture switched to ${params.posture}.` }],
				details: {},
				terminate: true,
			};
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (activePosture !== "plan") return undefined;
		if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return undefined;
		if (isPlanWritePath(ctx.cwd, event.input.path)) return undefined;

		if (!isEnabled()) return undefined;
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Plan posture may only write or edit under ${PLAN_WRITE_DIR}/`,
			};
		}

		const approved = await ctx.ui.confirm(
			"Switch to Act?",
			`Plan posture cannot ${event.toolName} ${event.input.path}. Switch to act and run this tool call?`,
		);

		if (approved) {
			await applyPosture("act", ctx, { quiet: true });
			return undefined;
		}

		const userReason = (
			await ctx.ui.input("Why not?", "Optional. Tell the agent why, or hit Enter to skip.")
		)?.trim();
		return {
			block: true,
			reason: userReason
				? `Posture switch denied. User reason: ${userReason}\n\nContinue under current posture.`
				: "Posture switch denied. Continue under current posture.",
		};
	});

	async function applyPosture(
		name: PostureName,
		ctx: ExtensionContext,
		options: { persist?: boolean; quiet?: boolean; fromRestore?: boolean } = {},
	): Promise<void> {
		if (!isEnabled()) {
			activePosture = undefined;
			nextTurnPosture = undefined;
			previousTools = undefined;
			updateFooter(pi, undefined);
			return;
		}

		const config = POSTURES[name];
		const enteringPlan = name === "plan" && activePosture !== "plan";
		const leavingPlan = activePosture === "plan" && name !== "plan";

		if (enteringPlan && !options.fromRestore) previousTools = pi.getActiveTools();

		pi.setThinkingLevel(config.thinkingLevel);

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

		if (options.persist !== false) persistPosture(pi, activePosture);
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

				if (name === "review") {
					await runReviewCommand(args, ctx);
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

	pi.registerShortcut(Key.alt("m"), {
		description: "Cycle Lyle posture",
		handler: async (ctx) => {
			await applyPosture(nextPosture(activePosture), ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const restored = latestPostureState(ctx.sessionManager.getEntries());
		if (!restored) {
			await applyPosture(DEFAULT_POSTURE, ctx, { persist: false, quiet: true });
			if (_event.reason === "new") await pickPosture(ctx, (name) => applyPosture(name, ctx));
			return;
		}

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

	async function runReviewCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const focus = commandPrompt(args);
		const wantNewChat = ctx.hasUI && (await ctx.ui.confirm("Review", "Review in a new chat?"));
		if (!wantNewChat) {
			await runPostureCommand("review", focus, ctx);
			return;
		}
		const chosen = await pickReviewModel(ctx);
		await startReviewInNewChat(pi, ctx, focus, chosen);
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

function updateFooter(pi: ExtensionAPI, activePosture: PostureName | undefined): void {
	setTauFooterItem(pi, {
		id: "tau-posture",
		text: activePosture,
		priority: 100,
	});
}

function persistPosture(pi: ExtensionAPI, name: PostureName): void {
	pi.appendEntry<PostureState>(POSTURE_STATE_TYPE, { name });
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

	return { name };
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

interface ReviewEvidenceParts {
	root: string;
	branch: string;
	fileCount: number;
	status: string;
	stagedPatch: string;
	unstagedPatch: string;
	untrackedPreview: string;
}

const REVIEW_MODEL_PICKER_CONFIG: Omit<SearchListConfig, "path"> = {
	title: "Model for review chat",
	emptyMessage: "No models match. Esc to keep the current model.",
	primaryLabel: "use",
	actions: [],
};

async function pickReviewModel(ctx: ExtensionCommandContext): Promise<Model<Api> | undefined> {
	// Only the TUI supports custom components; elsewhere skip the picker.
	if (ctx.mode !== "tui" || !ctx.hasUI) return undefined;

	const available = ctx.modelRegistry.getAvailable();
	if (available.length <= 1) return undefined;

	const current = ctx.model;

	const currentId = current ? modelKey(current) : undefined;
	const ordered = current ? [current, ...available.filter((model) => modelKey(model) !== currentId)] : available;

	const items: SearchListItem[] = ordered.map((model) => ({
		id: modelKey(model),
		text: formatModelLabel(model),
	}));

	const result = await ctx.ui.custom<SearchListResult>(
		(tui, theme, _keybindings, done) => new SearchList(tui, theme, items, REVIEW_MODEL_PICKER_CONFIG, done),
	);

	if (result.kind !== "primary") return undefined;

	const chosenId = result.item.id;
	if (chosenId === currentId) return undefined;
	return ordered.find((model) => modelKey(model) === chosenId);
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function formatModelLabel(model: Model<Api>): string {
	return model.name && model.name !== model.id
		? `${model.provider}/${model.name} (${model.id})`
		: `${model.provider}/${model.id}`;
}

async function startReviewInNewChat(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	focus: string | undefined,
	model: Model<Api> | undefined,
): Promise<void> {
	ctx.ui.setStatus("review", "gathering review evidence");

	let evidence: string | undefined;
	try {
		evidence = await gatherReviewEvidence(pi, ctx);
	} catch (error) {
		ctx.ui.notify(`Review cancelled: ${errorText(error)}`, "error");
		return;
	} finally {
		ctx.ui.setStatus("review", undefined);
	}
	if (!evidence) return;

	if (model && !(await pi.setModel(model))) {
		ctx.ui.notify(`Review cancelled: no auth for ${modelKey(model)}`, "error");
		return;
	}

	const kickoff = focus ? `Review the injected diff. Focus: ${focus}` : "Review the injected diff.";

	await ctx.newSession({
		setup: async (sm) => {
			sm.appendCustomEntry(POSTURE_STATE_TYPE, { name: "review" });
			sm.appendCustomMessageEntry(REVIEW_EVIDENCE_TYPE, evidence, false);
		},
		withSession: async (newCtx) => {
			await newCtx.sendUserMessage(kickoff);
		},
	});
}

async function gatherReviewEvidence(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string | undefined> {
	const git = createGitRunner(pi, ctx);
	const repo = await loadRepoStatus(git);
	if (!repo) {
		ctx.ui.notify("No git repository found.", "info");
		return undefined;
	}
	if (repo.fileCount === 0) {
		ctx.ui.notify("No uncommitted changes detected.", "info");
		return undefined;
	}
	const root = repo.root;

	const [status, stagedPatch, unstagedPatch, branch] = await Promise.all([
		git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: root }),
		git.run([...STAGED_PATCH_DIFF_ARGS], { cwd: root, optional: true }),
		git.run(["diff", "--stat", "--patch", "--no-color", "--no-ext-diff"], { cwd: root, optional: true }),
		git.run(["branch", "--show-current"], { cwd: root, optional: true }),
	]);

	return formatReviewEvidence({
		root,
		branch,
		fileCount: repo.fileCount,
		status: formatPorcelainStatus(status),
		stagedPatch,
		unstagedPatch,
		untrackedPreview: await formatUntrackedPreviews(root, status),
	});
}

function formatReviewEvidence(parts: ReviewEvidenceParts): string {
	return [
		"<tau_review_evidence>",
		`Repo: ${basename(parts.root)}`,
		`Branch: ${parts.branch || "(detached)"}`,
		`Changes: ${parts.fileCount} file(s)`,
		"",
		"Status:",
		parts.status || "(none)",
		"",
		"Staged diff vs HEAD:",
		truncReview(parts.stagedPatch || "(none)"),
		"",
		"Unstaged diff vs index:",
		truncReview(parts.unstagedPatch || "(none)"),
		"",
		"Untracked file previews:",
		parts.untrackedPreview || "(none)",
		"</tau_review_evidence>",
	].join("\n");
}

function truncReview(text: string): string {
	return text.length > MAX_REVIEW_DIFF_CHARS ? `${text.slice(0, MAX_REVIEW_DIFF_CHARS)}\n(truncated)` : text;
}

function formatPorcelainStatus(raw: string): string {
	return parsePorcelainV2Z(raw)
		.map((file) => `${file.status} ${file.path}`)
		.join("\n");
}

async function formatUntrackedPreviews(root: string, status: string): Promise<string> {
	const paths = parsePorcelainV2Z(status)
		.filter((file) => file.status === "??")
		.map((file) => file.path);
	const previews: string[] = [];
	for (const path of paths) previews.push(await formatUntrackedPreview(root, path));
	return truncReview(previews.join("\n\n"));
}

async function formatUntrackedPreview(root: string, path: string): Promise<string> {
	try {
		const fullPath = join(root, path);
		const info = await stat(fullPath);
		if (!info.isFile()) return `File: ${path}\nuntracked ${info.isDirectory() ? "directory" : "non-file"}`;
		if (info.size > MAX_REVIEW_UNTRACKED_PREVIEW_BYTES) return `File: ${path}\nuntracked file, ${info.size} bytes`;
		const bytes = await readFile(fullPath);
		if (bytes.includes(0)) return `File: ${path}\nuntracked binary file, ${info.size} bytes`;
		return `File: ${path}\nuntracked file preview:\n${bytes.toString("utf8")}`;
	} catch (error) {
		return `File: ${path}\nuntracked file preview unavailable: ${errorText(error)}`;
	}
}

function parsePorcelainV2Z(raw: string): { path: string; status: string }[] {
	const files: { path: string; status: string }[] = [];
	const entries = raw ? raw.split("\0").filter(Boolean) : [];

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		if (entry.startsWith("? ")) {
			files.push({ path: entry.slice(2), status: "??" });
			continue;
		}
		if (entry.startsWith("1 ")) {
			const [status, path] = parsePorcelainTracked(entry, 8);
			files.push({ path, status });
			continue;
		}
		if (entry.startsWith("2 ")) {
			const [status, path] = parsePorcelainTracked(entry, 9);
			files.push({ path, status });
			index++;
		}
	}

	return files;
}

function parsePorcelainTracked(entry: string, pathField: number): [string, string] {
	const fields = entry.split(" ");
	return [(fields[1] ?? "  ").replace(/\./g, " "), fields.slice(pathField).join(" ")];
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isPostureName(value: string): value is PostureName {
	return (POSTURE_ORDER as readonly string[]).includes(value);
}
