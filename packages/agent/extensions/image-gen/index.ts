import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	generateImage,
	type GeneratedImageResult,
	type GenerateImageRequest,
	type ImageGenerationContext,
	type ImageProvider,
} from "@shanepadgett/tau-agent";
import { type Static, Type } from "typebox";

const MAX_INLINE_BYTES = 12 * 1024 * 1024;

const imageGenSchema = Type.Object(
	{
		prompt: Type.String({ minLength: 1 }),
		provider: Type.Optional(
			Type.Union([Type.Literal("openai" satisfies ImageProvider), Type.Literal("xai" satisfies ImageProvider)], {
				description:
					"Image provider override. Omit to follow the parent model, preferring OpenAI for GPT and xAI for Grok.",
			}),
		),
		path: Type.Optional(
			Type.String({ description: "Explicit image destination path; defaults to Tau's external image store" }),
		),
		referenced_image_paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 3 })),
	},
	{ additionalProperties: false },
);

type ImageGenParams = Static<typeof imageGenSchema>;
type ImageGenDetails = Omit<GeneratedImageResult, "bytes">;

export default function imageGenExtension(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool<typeof imageGenSchema, ImageGenDetails | undefined>({
			name: "image_gen",
			label: "Image Generation",
			description:
				"Generate a requested raster image or AI-edit existing images with OpenAI GPT Image or xAI Grok Imagine. Omit provider to follow the parent model; set it to openai or xai to override. Omit referenced_image_paths to generate; pass one to three local paths to edit or compose. Omit path to use Tau's external image store; pass path only when the user explicitly requests a repository file or other destination. Returns the image for inspection.",
			parameters: imageGenSchema,
			async execute(_toolCallId, params: ImageGenParams, signal, onUpdate, ctx) {
				await onUpdate?.({
					content: [
						{
							type: "text",
							text: "Processing image request...",
						},
					],
					details: undefined,
				});
				const request = {
					prompt: params.prompt,
					provider: params.provider,
					path: params.path,
					referencedImagePaths: params.referenced_image_paths,
					signal,
				} satisfies GenerateImageRequest;
				const { bytes, ...details } = await generateImage(ctx satisfies ImageGenerationContext, request);
				const verb = details.operation === "generate" ? "Generated" : "Edited";
				if (bytes.length > MAX_INLINE_BYTES) {
					return {
						content: [
							{
								type: "text",
								text: `${verb} image saved to ${details.path}. The image exceeds the 12 MiB attachment limit, so it was not added to model context.`,
							},
						],
						details,
					};
				}
				return {
					content: [
						{ type: "text", text: `${verb} image saved to ${details.path}` },
						{ type: "image", data: bytes.toString("base64"), mimeType: details.mimeType },
					],
					details,
				};
			},
		}),
	);
}
