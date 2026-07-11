import type { JsonObject, TauExtensionSettingsSpec } from "./define.ts";
import { TAU_SCHEMA_URL } from "./paths.ts";

export function buildTauSettingsSchema(specs: readonly TauExtensionSettingsSpec[]): JsonObject {
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: TAU_SCHEMA_URL,
		title: "Tau Configuration",
		description: "Configuration for Tau and Tau extensions.",
		type: "object",
		properties: {
			$schema: {
				type: "string",
				description: "Optional schema reference used by editors for validation and autocomplete.",
			},
			extensions: {
				type: "object",
				properties: Object.fromEntries(specs.map((spec) => [spec.key, spec.schema])),
				additionalProperties: true,
				default: {},
			},
		},
		additionalProperties: false,
	};
}
