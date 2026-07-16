import { defineTool, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { detectImageMimeType, editImage, generateImage, type EditImage, type GeneratedImage } from "./client.ts";
import { XAI_IMAGE_MODEL, XAI_PROVIDER } from "./constants.ts";

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_INLINE_BYTES = 12 * 1024 * 1024;

const imageGenSchema = Type.Object(
	{
		prompt: Type.String({ minLength: 1 }),
		path: Type.Optional(
			Type.String({ description: "Explicit image destination path; defaults to Tau's external image store" }),
		),
		referenced_image_paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 3 })),
	},
	{ additionalProperties: false },
);

type ImageGenParams = Static<typeof imageGenSchema>;

interface ImageGenDetails {
	path: string;
	model: typeof XAI_IMAGE_MODEL;
	operation: "generate" | "edit";
}

function outputExtension(image: GeneratedImage): string {
	if (image.mimeType === "image/png") return ".png";
	if (image.mimeType === "image/webp") return ".webp";
	return ".jpg";
}

export default function imageGenExtension(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool<typeof imageGenSchema, ImageGenDetails | undefined>({
			name: "image_gen",
			label: "Image Generation",
			description:
				"Generate a requested raster image or AI-edit existing images with configured xAI authentication. Omit referenced_image_paths to generate; pass one to three local paths to edit or compose. Omit path to use Tau's external image store; pass path only when the user explicitly requests a repository file or other destination. Returns the image for inspection.",
			parameters: imageGenSchema,
			async execute(_toolCallId, params: ImageGenParams, signal, onUpdate, ctx) {
				signal?.throwIfAborted();
				const prompt = params.prompt.trim();
				if (!prompt) throw new Error("Image prompt cannot be empty");
				const requestedPath = params.path?.startsWith("@") ? params.path.slice(1) : params.path;
				if (requestedPath !== undefined && !requestedPath.trim()) throw new Error("Image path cannot be empty");
				const requestedAbsolutePath = requestedPath
					? isAbsolute(requestedPath)
						? requestedPath
						: resolve(ctx.cwd, requestedPath)
					: undefined;
				if (
					requestedAbsolutePath &&
					![".jpg", ".jpeg", ".png", ".webp"].includes(extname(requestedAbsolutePath).toLowerCase())
				) {
					throw new Error("Image path must end in .jpg, .jpeg, .png, or .webp");
				}

				const token = await ctx.modelRegistry.getApiKeyForProvider(XAI_PROVIDER);
				if (!token) {
					throw new Error("xAI authentication is unavailable. Run /login xai and choose a login method.");
				}
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
									? `Generating image with ${XAI_IMAGE_MODEL}...`
									: `Editing image with ${XAI_IMAGE_MODEL}...`,
						},
					],
					details: undefined,
				});
				const generated =
					operation === "generate"
						? await generateImage(prompt, token, signal)
						: await editImage(prompt, images, token, signal);
				signal?.throwIfAborted();
				const generatedExtension = outputExtension(generated);
				if (requestedAbsolutePath) {
					const requestedExtension = extname(requestedAbsolutePath).toLowerCase();
					const matches =
						requestedExtension === generatedExtension ||
						(generatedExtension === ".jpg" && requestedExtension === ".jpeg");
					if (!matches)
						throw new Error(`xAI returned ${generated.mimeType}; destination must end in ${generatedExtension}`);
				}
				const absolutePath =
					requestedAbsolutePath ??
					join(homedir(), ".local", "share", "tau-agent", "images", `image-${randomUUID()}${generatedExtension}`);

				const outputDirectory = dirname(absolutePath);
				await withFileMutationQueue(absolutePath, async () => {
					await mkdir(outputDirectory, { recursive: true });
					const temporaryPath = join(
						outputDirectory,
						`.${basename(absolutePath)}.${randomUUID()}.tmp${generatedExtension}`,
					);
					try {
						await writeFile(temporaryPath, generated.bytes, { flag: "wx" });
						signal?.throwIfAborted();
						await link(temporaryPath, absolutePath);
					} finally {
						await rm(temporaryPath, { force: true });
					}
				});

				const verb = operation === "generate" ? "Generated" : "Edited";
				const details: ImageGenDetails = { path: absolutePath, model: XAI_IMAGE_MODEL, operation };
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
