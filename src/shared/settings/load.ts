import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { JsonObject, TauExtensionSettingsSpec } from "./define.ts";
import { asObject, readJsonStatus, writeJsonObject } from "./json.ts";
import { mergeSettings } from "./merge.ts";
import { globalTauSettingsPath, projectTauSettingsPath, TAU_SCHEMA_URL } from "./paths.ts";

export type TauSettingsScope = "global" | "project";

export async function loadTauExtensionSettings<TDefaults extends JsonObject>(
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	spec: TauExtensionSettingsSpec<TDefaults>,
): Promise<TDefaults> {
	const [globalStatus, projectStatus] = await Promise.all([
		readJsonStatus(globalTauSettingsPath()),
		ctx.isProjectTrusted() ? readJsonStatus(await projectTauSettingsPath(ctx.cwd)) : Promise.resolve(undefined),
	]);

	let merged = spec.defaults;
	if (globalStatus?.exists && globalStatus.ok)
		merged = mergeSettings(merged, extensionSection(globalStatus.value, spec.key));
	if (projectStatus?.exists && projectStatus.ok)
		merged = mergeSettings(merged, extensionSection(projectStatus.value, spec.key));

	return Value.Check(spec.schema, merged) ? merged : spec.defaults;
}

export async function updateTauExtensionSettings<TDefaults extends JsonObject>(
	scope: TauSettingsScope,
	ctx: Pick<ExtensionContext, "cwd">,
	spec: TauExtensionSettingsSpec<TDefaults>,
	updater: (current: TDefaults) => TDefaults,
): Promise<void> {
	await updateTauSettings(scope, ctx, (current) => {
		const next = { ...current };
		const extensions = asObject(next.extensions) ?? {};
		extensions[spec.key] = updater((asObject(extensions[spec.key]) as TDefaults | undefined) ?? spec.defaults);
		next.extensions = extensions;
		return next;
	});
}

export async function updateTauSettings(
	scope: TauSettingsScope,
	ctx: Pick<ExtensionContext, "cwd">,
	updater: (current: JsonObject) => JsonObject,
): Promise<void> {
	const path = scope === "global" ? globalTauSettingsPath() : await projectTauSettingsPath(ctx.cwd);
	const currentStatus = await readJsonStatus(path);
	const current =
		currentStatus.exists && currentStatus.ok ? currentStatus.value : { $schema: TAU_SCHEMA_URL, extensions: {} };
	const next = updater(current);
	next.$schema = typeof next.$schema === "string" ? next.$schema : TAU_SCHEMA_URL;
	await writeJsonObject(path, next);
}

function extensionSection(root: JsonObject, key: string): JsonObject | undefined {
	return asObject(asObject(root.extensions)?.[key]);
}
