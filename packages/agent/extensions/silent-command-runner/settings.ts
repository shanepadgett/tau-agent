import { Type } from "typebox";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";

const commandSchema = Type.Object(
	{
		name: Type.String({ description: "Short command name shown in notifications and failure messages." }),
		command: Type.String({
			description: "Shell command run with sh -lc. In afterWrite, use unquoted {files} for changed-file arguments.",
		}),
		cwd: Type.Optional(
			Type.String({ default: ".", description: "Command working directory, relative to project root." }),
		),
		env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra environment values." })),
		details: Type.Optional(
			Type.String({ description: "Free-text explanation of what this command checks or runs." }),
		),
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

type CommandSettings = {
	name: string;
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	details?: string;
	includeGlobs?: string[];
	excludeGlobs?: string[];
	timeoutMs?: number;
};

export default defineTauExtensionSettings({
	key: "silentCommandRunner",
	defaults: {
		maxOutputBytes: 51200 as number,
		afterWrite: [] as CommandSettings[],
		afterRun: [] as CommandSettings[],
	},
	schema: Type.Object(
		{
			maxOutputBytes: Type.Optional(
				Type.Integer({
					default: 51200,
					minimum: 1,
					description:
						"Maximum stdout/stderr bytes per stream retained in expanded failure details; model output uses shared limits.",
				}),
			),
			afterWrite: Type.Optional(
				Type.Array(commandSchema, {
					default: [],
					description: "Silent commands run in order after a modifying tool changes matching files.",
				}),
			),
			afterRun: Type.Optional(
				Type.Array(commandSchema, {
					default: [],
					description:
						"Read-only final checks run by the checks tool, with automatic settlement fallback when verification is missing or stale.",
				}),
			),
		},
		{ additionalProperties: false },
	),
});
