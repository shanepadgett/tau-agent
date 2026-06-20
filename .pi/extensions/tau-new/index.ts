import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SlashCommandSource } from "@earendil-works/pi-coding-agent";
import { promptForDescription } from "../../../src/shared/description.ts";
import { pickReferences, type ReferenceItem, referenceLines } from "../../../src/shared/reference-picker.ts";

const KINDS = ["extension", "prompt", "theme", "skill"] as const;
const PLACEMENTS = ["tau", "local"] as const;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Kind = (typeof KINDS)[number];
type Placement = (typeof PLACEMENTS)[number];
type Subject = { kind: "extension"; placement: Placement } | { kind: "prompt" } | { kind: "theme" } | { kind: "skill" };

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
	if (name === undefined) return;

	if (name) {
		const collisions = getCollisions(pi, ctx, subject, name);
		if (collisions.length > 0) {
			ctx.ui.notify(`Target/name already exists: ${collisions.join(", ")}`, "error");
			return;
		}
	}

	const descriptionTitle = name ? `Describe ${label(subject)} ${name}` : `Describe ${label(subject)}`;
	const descriptionRequired = name
		? `Description required: describe ${label(subject)} ${name}`
		: `Description required: describe ${label(subject)}`;
	const description = await promptForDescription(ctx, descriptionTitle, descriptionRequired);
	if (!description) return;

	const references = await getReferences(pi, ctx);
	if (references === null) return;
	const message = buildMessage(subject, name, description.text, description.source === "idea", references);
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

async function getName(pi: ExtensionAPI, ctx: ExtensionCommandContext, subject: Subject): Promise<string | undefined> {
	let title = `Name for ${label(subject)} (blank = agent proposes names)`;
	while (true) {
		const value = await ctx.ui.input(title, "kebab-case-name");
		if (value === undefined) return undefined;

		const name = value.trim();
		if (!name) return "";
		const check = checkName(pi, ctx, subject, name);
		if (check.state === "ok") return name;

		ctx.ui.notify(check.message, check.state === "collision" ? "error" : "warning");
		title = `Name for ${label(subject)} (${check.message})`;
	}
}

async function getReferences(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<ReferenceItem[] | null> {
	const choice = await ctx.ui.select("Attach reference repos?", ["no", "yes"]);
	if (choice === undefined) return null;
	if (choice !== "yes") return [];
	return (await pickReferences(pi, ctx)) ?? null;
}

function checkName(pi: ExtensionAPI, ctx: ExtensionCommandContext, subject: Subject, name: string): Check {
	if (!name) return { state: "empty", message: "Enter a kebab-case name." };
	if (!NAME_PATTERN.test(name))
		return { state: "invalid", message: "Use lowercase letters, numbers, and single hyphens only." };

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
	if (subject.kind === "theme")
		return ctx.ui.getAllThemes().some((theme) => theme.name === name) ? [`theme ${name}`] : [];
	if (subject.kind === "prompt") return hasCommand(pi, [name]) ? [`command /${name}`] : [];
	if (subject.kind === "skill")
		return hasCommand(pi, [name, `skill:${name}`], "skill") ? [`command /skill:${name}`] : [];
	return [];
}

function targets(subject: Subject, name: string): string[] {
	if (subject.kind === "extension") {
		if (subject.placement === "local") return [`.pi/extensions/${name}`];
		return [`src/extensions/${name}`];
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

function buildMessage(
	subject: Subject,
	name: string,
	description: string,
	fromIdea: boolean,
	references: readonly ReferenceItem[],
): string {
	const refs = referenceLines(references);

	return [
		"# /tau-new scaffold request",
		"",
		"This request was generated by `/tau-new`; scaffold the requested Tau customization.",
		"Follow already loaded project instructions.",
		...(fromIdea
			? [
					"This request is from an idea. After completing it, ask whether to remove the completed idea from .pi/tau/ideas.jsonl.",
				]
			: []),
		"",
		`Kind: ${label(subject)}`,
		`Name: ${name || "not provided"}`,
		"",
		...(name
			? ["Target path(s):", ...targets(subject, name).map((target) => `- ${target}`)]
			: ["Target path(s): work out after naming"]),
		"",
		"Description:",
		description,
		...(refs.length > 0 ? ["", ...refs] : []),
		"",
		"Read relevant Pi docs first:",
		`- ${docs(subject)}`,
		"",
		"Scaffold rules:",
		...rules(subject, name).map((rule) => `- ${rule}`),
		"- Inspect current Tau package patterns before editing.",
		"- Work with the user to resolve scope, behavior, and constraints before editing; assume the description may be ambiguous.",
		...(name
			? []
			: [
					"- No name was provided. Propose a few kebab-case names from the description, help the user choose one, then use that name consistently.",
				]),
		"- Ask concise clarifying questions before editing when scope, naming, files, UX, or acceptance criteria are unclear.",
	].join("\n");
}

function docs(subject: Subject): string {
	if (subject.kind === "extension") return "extension docs, TUI docs, and extension examples";
	if (subject.kind === "prompt") return "prompt template docs";
	if (subject.kind === "theme") return "theme docs";
	return "skill docs";
}

function rules(subject: Subject, name: string): string[] {
	if (!name) return ["Do not create files until the user confirms a name."];
	if (subject.kind === "extension") {
		const path = targets(subject, name)[0]!;
		return [
			`Create ${path}/index.ts.`,
			placementRule(subject, path),
			"Use native Pi TUI components when UI is needed.",
			"Put Tau custom extension events in src/shared/events.ts.",
			"Add extra extension files only when they clearly improve readability.",
		];
	}
	if (subject.kind === "prompt") return [`Create prompts/${name}.md.`, "Use frontmatter with a useful description."];
	if (subject.kind === "theme") return [`Create themes/${name}.json.`, "Define every required theme color token."];
	return [`Create skills/${name}/SKILL.md.`, "Use required Agent Skills frontmatter with name and description."];
}

function placementRule(subject: { kind: "extension"; placement: Placement }, path: string): string {
	if (subject.placement === "local") return "Keep it local to this repo; do not add it to package.json.";
	return `Create ${path}/README.md.`;
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
