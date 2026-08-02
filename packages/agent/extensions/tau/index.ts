import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { readJsonStatus, writeJsonObject } from "../../shared/settings/json.ts";
import { exists, globalTauSettingsPath, projectTauSettingsPath, TAU_SCHEMA_URL } from "../../shared/settings/paths.ts";
import { discoverTauSettingsSpecs } from "../../shared/settings/specs.ts";

type Finding = { level: "global" | "project"; message: string; startup: boolean };

export default function tauExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tau", {
		description: "Tau utilities. Usage: /tau [init [--global|--project]|doctor]",
		handler: async (args, ctx) => run(ctx, args),
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" && event.reason !== "reload") return;
		const findings = (await inspect(ctx)).filter((finding) => finding.startup);
		if (findings.length > 0 && ctx.hasUI) ctx.ui.notify(renderDoctor(findings), "warning");
	});
}

async function run(ctx: ExtensionCommandContext, args: string): Promise<void> {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return runPicker(ctx);

	if (parts[0] === "doctor" && parts.length === 1) {
		const findings = await inspect(ctx);
		ctx.ui.notify(renderDoctor(findings), findings.length > 0 ? "warning" : "info");
		return;
	}

	if (parts[0] === "init") {
		const scope = parts.includes("--global") ? "global" : "project";
		await init(ctx, scope);
		return;
	}

	ctx.ui.notify("Usage: /tau [init [--global|--project]|doctor]", "warning");
}

async function runPicker(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Usage: /tau [init [--global|--project]|doctor]", "info");
		return;
	}

	const choice = await ctx.ui.select("Tau", ["init project config", "init global config", "doctor"]);
	if (choice === "init project config") await init(ctx, "project");
	else if (choice === "init global config") await init(ctx, "global");
	else if (choice === "doctor") {
		const findings = await inspect(ctx);
		ctx.ui.notify(renderDoctor(findings), findings.length > 0 ? "warning" : "info");
	}
}

async function init(ctx: ExtensionCommandContext, scope: "global" | "project"): Promise<void> {
	const path = scope === "global" ? globalTauSettingsPath() : await projectTauSettingsPath(ctx.cwd);
	if (await exists(path)) {
		ctx.ui.notify(`tau init skipped: ${path} already exists`, "warning");
		return;
	}

	await writeJsonObject(path, { $schema: TAU_SCHEMA_URL, extensions: {} });
	ctx.ui.notify(`tau init wrote ${path}`, "info");
}

function pushExtensionFindings(
	findings: Finding[],
	level: Finding["level"],
	path: string,
	extensions: unknown,
	specs: Awaited<ReturnType<typeof discoverTauSettingsSpecs>>,
): void {
	if (extensions !== undefined && (!extensions || typeof extensions !== "object" || Array.isArray(extensions))) {
		findings.push({ level, message: `extensions must be an object: ${path}`, startup: true });
		return;
	}
	const extensionRecord = (extensions ?? {}) as Record<string, unknown>;
	for (const spec of specs) {
		const section = extensionRecord[spec.key];
		if (section === undefined) continue;
		if (!Value.Check(spec.schema, section)) {
			findings.push({ level, message: `invalid extensions.${spec.key}: ${path}`, startup: true });
		}
	}
}

async function inspectPath(
	findings: Finding[],
	item: { level: Finding["level"]; path: string; trusted: boolean },
	specs: Awaited<ReturnType<typeof discoverTauSettingsSpecs>>,
): Promise<void> {
	const status = await readJsonStatus(item.path);
	if (!status.exists) return;
	if (!item.trusted) {
		findings.push({
			level: item.level,
			message: `project Tau settings ignored because project is not trusted: ${item.path}. Run /trust, then /reload.`,
			startup: true,
		});
		return;
	}
	if (!status.ok) {
		findings.push({ level: item.level, message: `malformed JSON: ${item.path}: ${status.error}`, startup: true });
		return;
	}
	if (typeof status.value.$schema !== "string") {
		findings.push({ level: item.level, message: `missing $schema: ${item.path}`, startup: false });
	}
	pushExtensionFindings(findings, item.level, item.path, status.value.extensions, specs);
}

async function inspect(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): Promise<Finding[]> {
	const findings: Finding[] = [];
	const specs = await discoverTauSettingsSpecs(ctx.cwd);
	const paths = [
		{ level: "global" as const, path: globalTauSettingsPath(), trusted: true },
		{ level: "project" as const, path: await projectTauSettingsPath(ctx.cwd), trusted: ctx.isProjectTrusted() },
	];
	for (const item of paths) await inspectPath(findings, item, specs);
	return findings;
}

function renderDoctor(findings: readonly Finding[]): string {
	if (findings.length === 0) return "tau doctor\nNo issues found.";
	return [
		"tau doctor",
		`Found ${findings.length} issue(s):`,
		...findings.map((finding) => `- ${finding.message}`),
	].join("\n");
}
