import { defineTool, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { editImage, generateImage, resolveCodexAuth, type EditImage } from "./client.ts";

const MODEL = "gpt-image-2";
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_INLINE_BYTES = 12 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const imageGenSchema = Type.Object(
	{
		prompt: Type.String({ minLength: 1 }),
		path: Type.Optional(
			Type.String({ description: "Explicit PNG destination path; defaults to Tau's external image store" }),
		),
		referenced_image_paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 5 })),
	},
	{ additionalProperties: false },
);

type ImageGenParams = Static<typeof imageGenSchema>;

interface ImageGenDetails {
	path: string;
	model: typeof MODEL;
	operation: "generate" | "edit";
}

function detectImageMimeType(bytes: Buffer): EditImage["mimeType"] | undefined {
	if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
		return "image/png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	return undefined;
}

export default function imageGenExtension(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool<typeof imageGenSchema, ImageGenDetails | undefined>({
			name: "image_gen",
			label: "Image Generation",
			description:
				"Generate a new raster image from a prompt, or edit one to five local raster images. Uses the existing OpenAI Codex OAuth login, saves a PNG under Tau's external image store unless an explicit path is provided, and returns the image for inspection.",
			promptSnippet: "Generate or edit raster images with OpenAI Codex",
			promptGuidelines: [
				"Use image_gen when the user asks for a generated raster image or an AI edit of local raster images.",
				"Omit referenced_image_paths when image_gen should create a new image.",
				"Pass one to five local paths in referenced_image_paths when image_gen should edit or compose existing images.",
				"Omit path for temporary external storage. Pass path only when the user wants the generated image saved in their repository or another explicit location.",
			],
			parameters: imageGenSchema,
			async execute(_toolCallId, params: ImageGenParams, signal, onUpdate, ctx) {
				signal?.throwIfAborted();
				const prompt = params.prompt.trim();
				if (!prompt) throw new Error("Image prompt cannot be empty");
				const requestedPath = params.path?.startsWith("@") ? params.path.slice(1) : params.path;
				if (requestedPath !== undefined && !requestedPath.trim()) throw new Error("Image path cannot be empty");
				const absolutePath = requestedPath
					? isAbsolute(requestedPath)
						? requestedPath
						: resolve(ctx.cwd, requestedPath)
					: join(homedir(), ".local", "share", "tau-agent", "images", `image-${randomUUID()}.png`);
				if (!absolutePath.toLowerCase().endsWith(".png")) throw new Error("Image path must end in .png");

				const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
				if (!token) {
					throw new Error("OpenAI Codex OAuth is unavailable. Run /login and select OpenAI Codex.");
				}
				const auth = resolveCodexAuth(token);
				const images: EditImage[] = [];
				for (const path of params.referenced_image_paths ?? []) {
					const rawPath = path.startsWith("@") ? path.slice(1) : path;
					if (!rawPath.trim()) throw new Error("Referenced image path cannot be empty");
					const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
					const metadata = await stat(absolutePath);
					if (!metadata.isFile()) throw new Error(`Referenced image is not a file: ${absolutePath}`);
					if (metadata.size > MAX_INPUT_BYTES) throw new Error(`Referenced image exceeds 50 MiB: ${absolutePath}`);
					const bytes = await readFile(absolutePath);
					if (bytes.length > MAX_INPUT_BYTES) throw new Error(`Referenced image exceeds 50 MiB: ${absolutePath}`);
					const mimeType = detectImageMimeType(bytes);
					if (!mimeType)
						throw new Error(`Referenced image is not a supported PNG, JPEG, or WebP file: ${absolutePath}`);
					images.push({ mimeType, data: bytes.toString("base64") });
				}

				const operation = images.length === 0 ? "generate" : "edit";
				await onUpdate?.({
					content: [
						{
							type: "text",
							text:
								operation === "generate"
									? `Generating image with ${MODEL}...`
									: `Editing image with ${MODEL}...`,
						},
					],
					details: undefined,
				});
				const generated =
					operation === "generate"
						? await generateImage(prompt, auth, signal)
						: await editImage(prompt, images, auth, signal);
				signal?.throwIfAborted();

				const outputDirectory = dirname(absolutePath);
				await withFileMutationQueue(absolutePath, async () => {
					await mkdir(outputDirectory, { recursive: true });
					const temporaryPath = join(outputDirectory, `.${basename(absolutePath)}.${randomUUID()}.tmp.png`);
					try {
						await writeFile(temporaryPath, generated.bytes, { flag: "wx" });
						signal?.throwIfAborted();
						await link(temporaryPath, absolutePath);
					} finally {
						await rm(temporaryPath, { force: true });
					}
				});

				const verb = operation === "generate" ? "Generated" : "Edited";
				const details: ImageGenDetails = { path: absolutePath, model: MODEL, operation };
				if (generated.bytes.length > MAX_INLINE_BYTES) {
					return {
						content: [
							{
								type: "text",
								text: `${verb} image saved to ${absolutePath}. The PNG exceeds the 12 MiB attachment limit, so it was not added to model context.`,
							},
						],
						details,
					};
				}
				return {
					content: [
						{ type: "text", text: `${verb} image saved to ${absolutePath}` },
						{ type: "image", data: generated.base64, mimeType: generated.mimeType },
					],
					details,
				};
			},
		}),
	);
}
