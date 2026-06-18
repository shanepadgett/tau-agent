import type { ExtensionAPI, ExtensionCommandContext, SlashCommandSource } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const KINDS = ["extension", "prompt", "theme", "skill"] as const;
const PLACEMENTS = ["core", "standalone"] as const;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PI_ROOT = "/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent";

type Kind = (typeof KINDS)[number];
type Placement = (typeof PLACEMENTS)[number];
type Subject =
	| { kind: "extension"; placement: Placement }
	| { kind: "prompt" }
	| { kind: "theme" }
	| { kind: "skill" };

interface Check {
	state: "empty" | "invalid" | "collision" | "ok";
	message: string;
}

export default function tauNew(pi: ExtensionAPI): void {
	pi.registerCommand("tau-new", {
		description: "Scaffold Tau extensions, prompts, themes, and skills",
		getArgumentCompletions: (prefix) => {
			const value = prefix.trimStart();
			if (value.includes(" ")) return null;
			return KINDS.filter((kind) => kind.startsWith(value)).map((kind) => ({ value: kind, label: kind }));
		},
		handler: async (args, ctx) => run(pi, ctx, args),
	});
}

async function run(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("tau-new requires interactive TUI mode.", "error");
		return;
	}

	const kind = await getKind(ctx, args);
	if (!kind) return;

	const subject = await getSubject(ctx, kind);
	if (!subject) return;

	const name = await getName(pi, ctx, subject);
	if (!name) return;

	const collisions = getCollisions(pi, ctx, subject, name);
	if (collisions.length > 0) {
		ctx.ui.notify(`Target/name already exists: ${collisions.join(", ")}`, "error");
		return;
	}

	const description = await getDescription(ctx, subject, name);
	if (!description) return;

	const message = buildMessage(subject, name, description);
	if (ctx.isIdle()) pi.sendUserMessage(message);
	else pi.sendUserMessage(message, { deliverAs: "followUp" });
}

async function getKind(ctx: ExtensionCommandContext, args: string): Promise<Kind | null> {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length > 1) {
		ctx.ui.notify("Usage: /tau-new [extension|prompt|theme|skill]", "warning");
		return null;
	}

	if (parts[0]) {
		if (isKind(parts[0])) return parts[0];
		ctx.ui.notify("Usage: /tau-new [extension|prompt|theme|skill]", "warning");
		return null;
	}

	const choice = await ctx.ui.select("Create Tau customization", [...KINDS]);
	return choice && isKind(choice) ? choice : null;
}

async function getSubject(ctx: ExtensionCommandContext, kind: Kind): Promise<Subject | null> {
	if (kind !== "extension") return { kind };

	const placement = await ctx.ui.select("Extension placement", [...PLACEMENTS]);
	return placement && isPlacement(placement) ? { kind, placement } : null;
}

async function getName(pi: ExtensionAPI, ctx: ExtensionCommandContext, subject: Subject): Promise<string | null> {
	let title = `Name for ${label(subject)}`;
	while (true) {
		const value = await ctx.ui.input(title, "kebab-case-name");
		if (value === undefined) return null;

		const name = value.trim();
		const check = checkName(pi, ctx, subject, name);
		if (check.state === "ok") return name;

		ctx.ui.notify(check.message, check.state === "collision" ? "error" : "warning");
		title = `Name for ${label(subject)} (${check.message})`;
	}
}

async function getDescription(ctx: ExtensionCommandContext, subject: Subject, name: string): Promise<string | null> {
	let title = `Describe ${label(subject)} ${name}`;
	while (true) {
		const value = await ctx.ui.editor(title, "");
		if (value === undefined) return null;
		const trimmed = value.trim();
		if (trimmed) return trimmed;
		title = `Description required: describe ${label(subject)} ${name}`;
	}
}

function checkName(pi: ExtensionAPI, ctx: ExtensionCommandContext, subject: Subject, name: string): Check {
	if (!name) return { state: "empty", message: "Enter a kebab-case name." };
	if (!NAME_PATTERN.test(name)) return { state: "invalid", message: "Use lowercase letters, numbers, and single hyphens only." };

	const collisions = getCollisions(pi, ctx, subject, name);
	if (collisions.length > 0) return { state: "collision", message: `Already exists: ${collisions.join(", ")}` };

	return { state: "ok", message: `Target: ${targets(subject, name).join(", ")}` };
}

function getCollisions(pi: ExtensionAPI, ctx: ExtensionCommandContext, subject: Subject, name: string): string[] {
	const paths = collisionPaths(subject, name)
		.filter((path) => existsSync(resolve(ctx.cwd, path)))
		.map((path) => `path ${path}`);
	return [...paths, ...nameCollisions(pi, ctx, subject, name)];
}

function nameCollisions(pi: ExtensionAPI, ctx: ExtensionCommandContext, subject: Subject, name: string): string[] {
	if (subject.kind === "theme") return ctx.ui.getAllThemes().some((theme) => theme.name === name) ? [`theme ${name}`] : [];
	if (subject.kind === "prompt") return hasCommand(pi, [name]) ? [`command /${name}`] : [];
	if (subject.kind === "skill") return hasCommand(pi, [name, `skill:${name}`], "skill") ? [`command /skill:${name}`] : [];
	return [];
}

function targets(subject: Subject, name: string): string[] {
	if (subject.kind === "extension") {
		return subject.placement === "core" ? [`src/extensions/core/src/${name}`] : [`src/extensions/${name}`];
	}
	if (subject.kind === "prompt") return [`prompts/${name}.md`];
	if (subject.kind === "theme") return [`themes/${name}.json`];
	return [`skills/${name}`];
}

function collisionPaths(subject: Subject, name: string): string[] {
	if (subject.kind === "skill") return [`skills/${name}`, `skills/${name}.md`];
	const [target] = targets(subject, name);
	return subject.kind === "extension" ? [target, `${target}.ts`] : [target];
}

function buildMessage(subject: Subject, name: string, description: string): string {
	return [
		"# /tau-new scaffold request",
		"",
		"This request was generated by `/tau-new`; scaffold the requested Tau customization.",
		"Follow already loaded project instructions.",
		"",
		`Kind: ${label(subject)}`,
		`Name: ${name}`,
		"",
		"Target path(s):",
		...targets(subject, name).map((target) => `- ${target}`),
		"",
		"Description:",
		"<description>",
		description,
		"</description>",
		"",
		"Read relevant Pi docs first:",
		...docs(subject).map((doc) => `- ${doc}`),
		"",
		"Scaffold rules:",
		...rules(subject, name).map((rule) => `- ${rule}`),
		"- Inspect current Tau package patterns before editing.",
		"- If ambiguity remains, ask concise clarifying questions before editing.",
	].join("\n");
}

function docs(subject: Subject): string[] {
	if (subject.kind === "extension") return [`${PI_ROOT}/docs/extensions.md`, `${PI_ROOT}/docs/tui.md`, `${PI_ROOT}/examples/extensions`];
	if (subject.kind === "prompt") return [`${PI_ROOT}/docs/prompt-templates.md`];
	if (subject.kind === "theme") return [`${PI_ROOT}/docs/themes.md`];
	return [`${PI_ROOT}/docs/skills.md`];
}

function rules(subject: Subject, name: string): string[] {
	if (subject.kind === "extension") {
		const path = subject.placement === "core" ? `src/extensions/core/src/${name}` : `src/extensions/${name}`;
		return [
			`Create ${path}/index.ts.`,
			subject.placement === "core"
				? "Wire it from src/extensions/core/index.ts and update src/extensions/core/README.md."
				: `Create ${path}/README.md.`,
			"Use native Pi TUI components when UI is needed.",
			"Put Tau custom extension events in src/shared/events.ts.",
			"Add extra extension files only when they clearly improve readability.",
		];
	}
	if (subject.kind === "prompt") return [`Create prompts/${name}.md.`, "Use frontmatter with a useful description."];
	if (subject.kind === "theme") return [`Create themes/${name}.json.`, "Define every required theme color token."];
	return [`Create skills/${name}/SKILL.md.`, "Use required Agent Skills frontmatter with name and description."];
}

function label(subject: Subject): string {
	return subject.kind === "extension" ? `${subject.placement} extension` : subject.kind;
}

function hasCommand(pi: ExtensionAPI, names: string[], source?: SlashCommandSource): boolean {
	return pi
		.getCommands()
		.some(
			(command) =>
				(source === undefined || command.source === source) &&
				names.some((name) => command.name === name || command.name.startsWith(`${name}:`)),
		);
}

function isKind(value: string): value is Kind {
	return KINDS.some((kind) => kind === value);
}

function isPlacement(value: string): value is Placement {
	return PLACEMENTS.some((placement) => placement === value);
}
