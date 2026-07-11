import type { TSchema } from "typebox";

export type JsonObject = Record<string, unknown>;

export interface TauExtensionSettingsSpec<TDefaults extends JsonObject = JsonObject> {
	key: string;
	defaults: TDefaults;
	schema: TSchema;
}

export function defineTauExtensionSettings<const TDefaults extends JsonObject>(
	spec: TauExtensionSettingsSpec<TDefaults>,
): TauExtensionSettingsSpec<TDefaults> {
	return spec;
}
