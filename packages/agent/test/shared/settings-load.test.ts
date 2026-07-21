import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineTauExtensionSettings } from "../../shared/settings/define.ts";
import type { JsonStatus } from "../../shared/settings/json.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";

const mocks = vi.hoisted(() => ({ readJsonStatus: vi.fn() }));

vi.mock("../../shared/settings/json.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../shared/settings/json.ts")>()),
	readJsonStatus: mocks.readJsonStatus,
}));

vi.mock("../../shared/settings/paths.ts", () => ({
	globalTauSettingsPath: () => "/global/settings.json",
	projectTauSettingsPath: async () => "/project/.pi/tau/settings.json",
	TAU_SCHEMA_URL: "https://example.com/tau.schema.json",
}));

const contextPruningLikeSettings = defineTauExtensionSettings({
	key: "contextPruningLike",
	defaults: {
		enabled: true as boolean,
		nudgeEveryPercent: 20 as number,
		pressurePercent: 50 as number,
		minimumReclaimTokens: 8000 as number,
	},
	schema: Type.Object(
		{
			enabled: Type.Optional(Type.Boolean({ default: true })),
			nudgeEveryPercent: Type.Optional(Type.Integer({ default: 20, minimum: 1, maximum: 100 })),
			pressurePercent: Type.Optional(Type.Integer({ default: 50, minimum: 1, maximum: 99 })),
			minimumReclaimTokens: Type.Optional(Type.Integer({ default: 8000, minimum: 1 })),
		},
		{ additionalProperties: false },
	),
});

const nestedSettings = defineTauExtensionSettings({
	key: "nested",
	defaults: { group: { enabled: true as boolean, interval: 5 as number } },
	schema: Type.Object(
		{
			group: Type.Optional(
				Type.Object(
					{
						enabled: Type.Optional(Type.Boolean({ default: true })),
						interval: Type.Optional(Type.Integer({ default: 5, minimum: 1 })),
					},
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
});

const ctx = {
	cwd: "/project",
	isProjectTrusted: () => true,
} satisfies Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

describe("loadTauExtensionSettings", () => {
	beforeEach(() => {
		mocks.readJsonStatus.mockReset();
	});

	it("uses each documented default for invalid properties while preserving valid siblings", async () => {
		mocks.readJsonStatus
			.mockResolvedValueOnce(
				settingsStatus("/global/settings.json", "contextPruningLike", {
					nudgeEveryPercent: 40,
					pressurePercent: 60,
				}),
			)
			.mockResolvedValueOnce(
				settingsStatus("/project/.pi/tau/settings.json", "contextPruningLike", {
					enabled: false,
					nudgeEveryPercent: 0,
					pressurePercent: 70,
					minimumReclaimTokens: "9000",
					unknown: true,
				}),
			);

		await expect(loadTauExtensionSettings(ctx, contextPruningLikeSettings)).resolves.toEqual({
			enabled: false,
			nudgeEveryPercent: 20,
			pressurePercent: 70,
			minimumReclaimTokens: 8000,
		});
	});

	it("replaces an invalid nested property without discarding its valid sibling", async () => {
		mocks.readJsonStatus
			.mockResolvedValueOnce(settingsStatus("/global/settings.json", "nested", {}))
			.mockResolvedValueOnce(
				settingsStatus("/project/.pi/tau/settings.json", "nested", {
					group: { enabled: false, interval: 0 },
				}),
			);

		await expect(loadTauExtensionSettings(ctx, nestedSettings)).resolves.toEqual({
			group: { enabled: false, interval: 5 },
		});
	});
});

function settingsStatus(path: string, key: string, section: Record<string, unknown>): JsonStatus {
	return { exists: true, path, ok: true, value: { extensions: { [key]: section } } };
}
