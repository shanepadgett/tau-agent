import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

const commandSchema = Type.Object(
	{
		name: Type.String({ description: "Short command name shown in notifications and failure messages." }),
		enabled: Type.Optional(Type.Boolean({ default: true, description: "Enable this command." })),
		command: Type.String({ description: "Shell command run with sh -lc after matching files change." }),
		cwd: Type.Optional(
			Type.String({ default: ".", description: "Command working directory, relative to project root." }),
		),
		env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra environment values." })),
		includeGlobs: Type.Optional(
			Type.Array(Type.String(), {
				default: ["**/*"],
				description: "Project-relative files that trigger this command.",
			}),
		),
		excludeGlobs: Type.Optional(
			Type.Array(Type.String(), { default: [], description: "Project-relative files ignored for this command." }),
		),
		timeoutMs: Type.Optional(
			Type.Integer({ default: 120000, minimum: 1, description: "Command timeout in milliseconds." }),
		),
	},
	{ additionalProperties: false },
);

export default defineTauExtensionSettings({
	key: "silentCommandRunner",
	defaults: {
		enabled: true as boolean,
		maxOutputBytes: 51200 as number,
		commands: [] as Array<{
			name: string;
			enabled?: boolean;
			command: string;
			cwd?: string;
			env?: Record<string, string>;
			includeGlobs?: string[];
			excludeGlobs?: string[];
			timeoutMs?: number;
		}>,
	},
	schema: Type.Object(
		{
			enabled: Type.Optional(Type.Boolean({ default: true, description: "Enable silent command runner." })),
			maxOutputBytes: Type.Optional(
				Type.Integer({
					default: 51200,
					minimum: 1,
					description: "Maximum raw stdout/stderr bytes sent to the agent.",
				}),
			),
			commands: Type.Optional(
				Type.Array(commandSchema, { default: [], description: "Commands run after matched files change." }),
			),
		},
		{ additionalProperties: false },
	),
});
