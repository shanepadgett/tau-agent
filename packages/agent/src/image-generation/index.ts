import { withFileMutationQueue, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { imageSize } from "image-size";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { detectImageMimeType, editImage, requestGeneratedImage } from "./client.ts";
import { OPENAI_IMAGE_MODEL, OPENAI_PROVIDER, XAI_IMAGE_MODEL, XAI_PROVIDER, type ImageProvider } from "./constants.ts";

export type { ImageProvider } from "./constants.ts";

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 2000;
const OUTPUT_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export type ImageGenerationContext = Pick<ExtensionContext, "cwd" | "model" | "modelRegistry">;

export interface GenerateImageRequest {
	prompt: string;
	provider?: ImageProvider;
	path?: string;
	referencedImagePaths?: readonly string[];
	signal?: AbortSignal;
}

export interface GeneratedImageResult {
	bytes: Buffer;
	path: string;
	provider: ImageProvider;
	model: typeof OPENAI_IMAGE_MODEL | typeof XAI_IMAGE_MODEL;
	operation: "generate" | "edit";
	mimeType: "image/png" | "image/jpeg" | "image/webp";
	width: number;
	height: number;
}

type ReferencedImage = {
	mimeType: "image/png" | "image/jpeg" | "image/webp";
	data: string;
};

function outputExtension(mimeType: GeneratedImageResult["mimeType"]): string {
	if (mimeType === "image/png") return ".png";
	if (mimeType === "image/webp") return ".webp";
	return ".jpg";
}

function providerLabel(provider: ImageProvider): string {
	return provider === "openai" ? "OpenAI Codex" : "xAI";
}

function sanitizedError(error: unknown, signal: AbortSignal | undefined, secrets: readonly string[]): unknown {
	if (signal?.aborted) return signal.reason;
	let message = error instanceof Error ? error.message : "Image generation failed";
	for (const secret of secrets) {
		if (secret) message = message.replaceAll(secret, "[redacted]");
	}
	message = [...message]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
		})
		.join("")
		.slice(0, MAX_ERROR_MESSAGE_LENGTH)
		.trim();
	return new Error(message || "Image generation failed");
}

function parsePrompt(request: GenerateImageRequest): string {
	if (typeof request.prompt !== "string") throw new Error("Image prompt must be a string");
	if (request.provider !== undefined && request.provider !== "openai" && request.provider !== "xai") {
		throw new Error("Image provider must be openai or xai");
	}
	if (request.path !== undefined && typeof request.path !== "string") throw new Error("Image path must be a string");
	if (request.referencedImagePaths !== undefined && !Array.isArray(request.referencedImagePaths)) {
		throw new Error("Referenced image paths must be an array");
	}
	const prompt = request.prompt.trim();
	if (!prompt) throw new Error("Image prompt cannot be empty");
	if (request.referencedImagePaths && request.referencedImagePaths.length > 3) {
		throw new Error("Image generation accepts at most three referenced images");
	}
	return prompt;
}

function resolveRequestedAbsolutePath(cwd: string, path: string | undefined): string | undefined {
	const requestedPath = path?.startsWith("@") ? path.slice(1) : path;
	if (requestedPath !== undefined && !requestedPath.trim()) throw new Error("Image path cannot be empty");
	if (!requestedPath) return undefined;
	const absolutePath = isAbsolute(requestedPath) ? requestedPath : resolve(cwd, requestedPath);
	if (!OUTPUT_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
		throw new Error("Image path must end in .jpg, .jpeg, .png, or .webp");
	}
	return absolutePath;
}

function providerCandidates(
	requestProvider: ImageProvider | undefined,
	parentUsesXai: boolean,
): readonly ImageProvider[] {
	const preferred: ImageProvider = requestProvider ?? (parentUsesXai ? "xai" : "openai");
	if (requestProvider) return [requestProvider];
	return preferred === "xai" ? ["xai", "openai"] : ["openai", "xai"];
}

async function resolveProviderAuth(
	ctx: ImageGenerationContext,
	requestProvider: ImageProvider | undefined,
	signal: AbortSignal | undefined,
	secrets: string[],
): Promise<{ provider: ImageProvider; token: string }> {
	const parentUsesXai =
		ctx.model?.provider.toLowerCase() === XAI_PROVIDER || ctx.model?.id.toLowerCase().includes("grok") === true;
	for (const candidate of providerCandidates(requestProvider, parentUsesXai)) {
		signal?.throwIfAborted();
		const candidateToken = await ctx.modelRegistry.getApiKeyForProvider(
			candidate === "openai" ? OPENAI_PROVIDER : XAI_PROVIDER,
		);
		signal?.throwIfAborted();
		if (!candidateToken) continue;
		secrets.push(candidateToken);
		return { provider: candidate, token: candidateToken };
	}
	if (requestProvider === "openai") {
		throw new Error("OpenAI Codex authentication is unavailable. Run /login openai-codex.");
	}
	if (requestProvider === "xai") {
		throw new Error("xAI authentication is unavailable. Run /login xai and choose a login method.");
	}
	throw new Error("Image generation authentication is unavailable. Run /login for OpenAI Codex or xAI.");
}

async function loadOneReferencedImage(
	cwd: string,
	path: string,
	signal: AbortSignal | undefined,
): Promise<ReferencedImage> {
	signal?.throwIfAborted();
	if (typeof path !== "string") throw new Error("Referenced image path must be a string");
	const rawPath = path.startsWith("@") ? path.slice(1) : path;
	if (!rawPath.trim()) throw new Error("Referenced image path cannot be empty");
	const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
	const metadata = await stat(absolutePath);
	signal?.throwIfAborted();
	if (!metadata.isFile()) throw new Error(`Referenced image is not a file: ${absolutePath}`);
	if (metadata.size > MAX_INPUT_BYTES) throw new Error(`Referenced image exceeds 50 MiB: ${absolutePath}`);
	const bytes = await readFile(absolutePath, { signal });
	if (bytes.length > MAX_INPUT_BYTES) throw new Error(`Referenced image exceeds 50 MiB: ${absolutePath}`);
	const mimeType = detectImageMimeType(bytes);
	if (!mimeType) {
		throw new Error(`Referenced image is not a supported PNG, JPEG, or WebP file: ${absolutePath}`);
	}
	return { mimeType, data: bytes.toString("base64") };
}

async function loadReferencedImages(
	cwd: string,
	paths: readonly string[] | undefined,
	signal: AbortSignal | undefined,
): Promise<ReferencedImage[]> {
	const images: ReferencedImage[] = [];
	for (const path of paths ?? []) images.push(await loadOneReferencedImage(cwd, path, signal));
	return images;
}

function readImageDimensions(bytes: Buffer, provider: ImageProvider): { width: number; height: number } {
	let dimensions: ReturnType<typeof imageSize>;
	try {
		dimensions = imageSize(bytes);
	} catch {
		throw new Error(`${providerLabel(provider)} returned invalid image dimensions`);
	}
	if (
		!Number.isInteger(dimensions.width) ||
		dimensions.width <= 0 ||
		!Number.isInteger(dimensions.height) ||
		dimensions.height <= 0
	) {
		throw new Error(`${providerLabel(provider)} returned invalid image dimensions`);
	}
	return { width: dimensions.width, height: dimensions.height };
}

function assertDestinationMatchesMime(
	requestedAbsolutePath: string | undefined,
	mimeType: GeneratedImageResult["mimeType"],
	provider: ImageProvider,
): string {
	const generatedExtension = outputExtension(mimeType);
	if (requestedAbsolutePath) {
		const requestedExtension = extname(requestedAbsolutePath).toLowerCase();
		const matches =
			requestedExtension === generatedExtension || (generatedExtension === ".jpg" && requestedExtension === ".jpeg");
		if (!matches) {
			throw new Error(
				`${providerLabel(provider)} returned ${mimeType}; destination must end in ${generatedExtension}`,
			);
		}
	}
	return generatedExtension;
}

async function writeImageAtomically(
	absolutePath: string,
	bytes: Buffer,
	generatedExtension: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	const outputDirectory = dirname(absolutePath);
	await withFileMutationQueue(absolutePath, async () => {
		await mkdir(outputDirectory, { recursive: true });
		const temporaryPath = join(
			outputDirectory,
			`.${basename(absolutePath)}.${randomUUID()}.tmp${generatedExtension}`,
		);
		try {
			await writeFile(temporaryPath, bytes, { flag: "wx", signal });
			signal?.throwIfAborted();
			await link(temporaryPath, absolutePath);
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	});
}

export async function generateImage(
	ctx: ImageGenerationContext,
	request: GenerateImageRequest,
): Promise<GeneratedImageResult> {
	const signal = request.signal;
	const secrets: string[] = [];
	try {
		signal?.throwIfAborted();
		const prompt = parsePrompt(request);
		const requestedAbsolutePath = resolveRequestedAbsolutePath(ctx.cwd, request.path);
		const { provider, token } = await resolveProviderAuth(ctx, request.provider, signal, secrets);
		const images = await loadReferencedImages(ctx.cwd, request.referencedImagePaths, signal);
		const operation = images.length === 0 ? "generate" : "edit";
		const model = provider === "openai" ? OPENAI_IMAGE_MODEL : XAI_IMAGE_MODEL;
		signal?.throwIfAborted();
		const generated =
			operation === "generate"
				? await requestGeneratedImage(provider, prompt, token, signal)
				: await editImage(provider, prompt, images, token, signal);
		signal?.throwIfAborted();
		const generatedExtension = assertDestinationMatchesMime(requestedAbsolutePath, generated.mimeType, provider);
		const dimensions = readImageDimensions(generated.bytes, provider);
		const absolutePath =
			requestedAbsolutePath ??
			join(homedir(), ".local", "share", "tau-agent", "images", `image-${randomUUID()}${generatedExtension}`);
		await writeImageAtomically(absolutePath, generated.bytes, generatedExtension, signal);
		return {
			bytes: generated.bytes,
			path: absolutePath,
			provider,
			model,
			operation,
			mimeType: generated.mimeType,
			width: dimensions.width,
			height: dimensions.height,
		};
	} catch (error) {
		throw sanitizedError(error, signal, secrets);
	}
}
