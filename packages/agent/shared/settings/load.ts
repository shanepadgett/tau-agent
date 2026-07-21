import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IsObject, type TSchema } from "typebox";
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

	if (Value.Check(spec.schema, merged)) return merged;
	const repaired = replaceInvalidProperties(spec.schema, merged, spec.defaults);
	return repaired !== NO_DEFAULT && Value.Check(spec.schema, repaired) ? (repaired as TDefaults) : spec.defaults;
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

async function updateTauSettings(
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

const NO_DEFAULT = Symbol("no-default");

function replaceInvalidProperties(
	schema: TSchema,
	value: unknown,
	documentedDefault: unknown | typeof NO_DEFAULT,
): unknown | typeof NO_DEFAULT {
	if (Value.Check(schema, value)) return value;

	const valueObject = asObject(value);
	if (IsObject(schema) && valueObject) {
		const defaultObject = documentedDefault === NO_DEFAULT ? undefined : asObject(documentedDefault);
		const repaired: JsonObject = {};
		const required = new Set(Array.isArray(schema.required) ? schema.required : []);
		for (const [key, propertySchema] of Object.entries(schema.properties)) {
			if (!Object.hasOwn(valueObject, key)) {
				if (!required.has(key)) continue;
				const requiredDefault = propertyDefault(propertySchema, defaultObject, key);
				if (requiredDefault === NO_DEFAULT) return validatedDefault(schema, documentedDefault);
				repaired[key] = Value.Clone(requiredDefault);
				continue;
			}

			const propertyValue = replaceInvalidProperties(
				propertySchema,
				valueObject[key],
				propertyDefault(propertySchema, defaultObject, key),
			);
			if (propertyValue !== NO_DEFAULT) repaired[key] = propertyValue;
			else if (required.has(key)) return validatedDefault(schema, documentedDefault);
		}

		const schemaObject = asObject(schema);
		const additionalProperties = schemaObject?.additionalProperties;
		if (additionalProperties !== false) {
			for (const [key, additionalValue] of Object.entries(valueObject)) {
				if (Object.hasOwn(schema.properties, key)) continue;
				if (additionalProperties === undefined || additionalProperties === true) repaired[key] = additionalValue;
				else {
					const repairedAdditional = replaceInvalidProperties(
						additionalProperties as TSchema,
						additionalValue,
						NO_DEFAULT,
					);
					if (repairedAdditional !== NO_DEFAULT) repaired[key] = repairedAdditional;
				}
			}
		}

		if (Value.Check(schema, repaired)) return repaired;
	}

	return validatedDefault(schema, documentedDefault);
}

function propertyDefault(
	schema: TSchema,
	defaultObject: JsonObject | undefined,
	key: string,
): unknown | typeof NO_DEFAULT {
	if (defaultObject && Object.hasOwn(defaultObject, key)) return defaultObject[key];
	const schemaObject = asObject(schema);
	return schemaObject && Object.hasOwn(schemaObject, "default") ? schemaObject.default : NO_DEFAULT;
}

function validatedDefault(
	schema: TSchema,
	documentedDefault: unknown | typeof NO_DEFAULT,
): unknown | typeof NO_DEFAULT {
	return documentedDefault !== NO_DEFAULT && Value.Check(schema, documentedDefault)
		? Value.Clone(documentedDefault)
		: NO_DEFAULT;
}
