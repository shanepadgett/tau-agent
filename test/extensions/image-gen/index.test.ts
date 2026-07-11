import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
	resolveCodexAuth: vi.fn((token: string) => ({ token, accountId: "account" })),
	generateImage: vi.fn(),
	editImage: vi.fn(),
}));

vi.mock("../../../src/extensions/image-gen/client.ts", () => client);

import imageGenExtension from "../../../src/extensions/image-gen/index.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

interface RegisteredTool {
	name: string;
	parameters: unknown;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute: (
		id: string,
		params: {
			prompt: string;
			path?: string;
			referenced_image_paths?: string[];
		},
		signal: AbortSignal | undefined,
		onUpdate: ((result: unknown) => void | Promise<void>) | undefined,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text?: string; data?: string }>; details: Record<string, unknown> }>;
}

function harness(token: string | null = "token"): { tool: RegisteredTool; apiKey: ReturnType<typeof vi.fn> } {
	let tool: RegisteredTool | undefined;
	const apiKey = vi.fn(async () => token ?? undefined);
	const pi = {
		events: createEventBus(),
		registerTool(value: RegisteredTool) {
			tool = value;
		},
	} as unknown as ExtensionAPI;
	imageGenExtension(pi);
	if (!tool) throw new Error("image_gen was not registered");
	return { tool, apiKey };
}

function context(cwd: string, apiKey: ReturnType<typeof vi.fn>): ExtensionContext {
	return {
		cwd,
		modelRegistry: { getApiKeyForProvider: apiKey },
	} as unknown as ExtensionContext;
}

beforeEach(() => {
	vi.clearAllMocks();
	client.generateImage.mockResolvedValue({ bytes: PNG, base64: PNG.toString("base64"), mimeType: "image/png" });
	client.editImage.mockResolvedValue({ bytes: PNG, base64: PNG.toString("base64"), mimeType: "image/png" });
});

afterEach(() => vi.unstubAllEnvs());

describe("image_gen extension", () => {
	it("registers the intended tool metadata", () => {
		const { tool } = harness();
		expect(tool.name).toBe("image_gen");
		expect(tool.promptSnippet).toContain("Generate or edit raster images");
		expect(tool.promptGuidelines).toHaveLength(4);
		expect(tool.parameters).toBeDefined();
	});

	it("requires a non-whitespace prompt before resolving auth", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "tau-image-gen-test-"));
		try {
			const { tool, apiKey } = harness();
			await expect(tool.execute("id", { prompt: "  " }, undefined, undefined, context(cwd, apiKey))).rejects.toThrow(
				"Image prompt cannot be empty",
			);
			expect(apiKey).not.toHaveBeenCalled();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("requires the existing OpenAI Codex login", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "tau-image-gen-test-"));
		try {
			const { tool, apiKey } = harness(null);
			await expect(tool.execute("id", { prompt: "x" }, undefined, undefined, context(cwd, apiKey))).rejects.toThrow(
				"Run /login and select OpenAI Codex",
			);
			expect(apiKey).toHaveBeenCalledWith("openai-codex");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("generates, safely saves, and returns a PNG", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "tau-image-gen-test-"));
		try {
			const updates: unknown[] = [];
			const { tool, apiKey } = harness();
			const result = await tool.execute(
				"id",
				{ prompt: " blue whale ", path: "result.png" },
				undefined,
				(value) => {
					updates.push(value);
				},
				context(cwd, apiKey),
			);
			expect(client.generateImage).toHaveBeenCalledWith(
				"blue whale",
				{ token: "token", accountId: "account" },
				undefined,
			);
			expect(client.editImage).not.toHaveBeenCalled();
			expect(result.details).toMatchObject({ model: "gpt-image-2", operation: "generate" });
			expect(result.content[1]).toEqual({ type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
			const path = String(result.details.path);
			expect(await readFile(path)).toEqual(PNG);
			expect(path).toBe(join(cwd, "result.png"));
			expect(await readdir(cwd)).toEqual(["result.png"]);
			expect(updates).toEqual([
				expect.objectContaining({ content: [{ type: "text", text: "Generating image with gpt-image-2..." }] }),
			]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("uses Tau's external image store when no destination is requested", async () => {
		const home = await mkdtemp(join(tmpdir(), "tau-image-gen-home-"));
		try {
			vi.stubEnv("HOME", home);
			const { tool, apiKey } = harness();
			const result = await tool.execute("id", { prompt: "external" }, undefined, undefined, context(home, apiKey));
			const path = String(result.details.path);
			expect(path.startsWith(join(home, ".local", "share", "tau-agent", "images", "image-"))).toBe(true);
			expect(await readFile(path)).toEqual(PNG);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("does not replace an existing explicit destination", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "tau-image-gen-test-"));
		try {
			const destination = join(cwd, "existing.png");
			await writeFile(destination, "keep");
			const { tool, apiKey } = harness();
			await expect(
				tool.execute("id", { prompt: "x", path: destination }, undefined, undefined, context(cwd, apiKey)),
			).rejects.toThrow();
			expect(await readFile(destination, "utf8")).toBe("keep");
			expect((await readdir(cwd)).filter((name) => name.includes(".tmp.png"))).toEqual([]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("detects local edit images by content and preserves their order", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "tau-image-gen-test-"));
		try {
			const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1]);
			const webp = Buffer.concat([Buffer.from("RIFF0000WEBP"), Buffer.from([1])]);
			await writeFile(join(cwd, "first.bin"), jpeg);
			await writeFile(join(cwd, "second.bin"), webp);
			const { tool, apiKey } = harness();
			const result = await tool.execute(
				"id",
				{
					prompt: "edit",
					path: "edited.png",
					referenced_image_paths: ["@first.bin", join(cwd, "second.bin")],
				},
				undefined,
				undefined,
				context(cwd, apiKey),
			);
			expect(client.editImage).toHaveBeenCalledWith(
				"edit",
				[
					{ mimeType: "image/jpeg", data: jpeg.toString("base64") },
					{ mimeType: "image/webp", data: webp.toString("base64") },
				],
				{ token: "token", accountId: "account" },
				undefined,
			);
			expect(result.details.operation).toBe("edit");
			expect(result.content[0]?.text).toContain("Edited image saved to");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects unsupported referenced image content before a request", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "tau-image-gen-test-"));
		try {
			await writeFile(join(cwd, "image.svg"), "<svg/>");
			const { tool, apiKey } = harness();
			await expect(
				tool.execute(
					"id",
					{ prompt: "edit", referenced_image_paths: ["image.svg"] },
					undefined,
					undefined,
					context(cwd, apiKey),
				),
			).rejects.toThrow("not a supported PNG, JPEG, or WebP file");
			expect(client.editImage).not.toHaveBeenCalled();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("saves oversized PNGs without attaching them", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "tau-image-gen-test-"));
		try {
			const oversized = Buffer.alloc(12 * 1024 * 1024 + 1);
			PNG.copy(oversized);
			client.generateImage.mockResolvedValue({
				bytes: oversized,
				base64: oversized.toString("base64"),
				mimeType: "image/png",
			});
			const { tool, apiKey } = harness();
			const result = await tool.execute(
				"id",
				{ prompt: "large", path: "large.png" },
				undefined,
				undefined,
				context(cwd, apiKey),
			);
			expect(result.content).toHaveLength(1);
			expect(result.content[0]?.text).toContain("exceeds the 12 MiB attachment limit");
			expect((await readFile(String(result.details.path))).length).toBe(oversized.length);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
