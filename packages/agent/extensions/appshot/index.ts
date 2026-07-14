import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { encode } from "@toon-format/toon";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { createToolRowStateStore, formatToolRowTitle } from "../../shared/tool-row-state.js";
import { createNativeHelper, type RunHelper } from "./native-helper.ts";

const MAX_PNG_BYTES = 12 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const listWindowsSchema = Type.Object({}, { additionalProperties: false });
const screenshotWindowSchema = Type.Object(
	{
		window_id: Type.Integer({ minimum: 1, description: "Window ID returned by list_windows" }),
		path: Type.String({ description: "Destination path for the PNG file (relative or absolute)" }),
	},
	{ additionalProperties: false },
);
const activateAppSchema = Type.Object(
	{ pid: Type.Integer({ minimum: 1, description: "Application process ID returned by list_windows" }) },
	{ additionalProperties: false },
);

type ScreenshotWindowParams = Static<typeof screenshotWindowSchema>;

interface WindowInfo {
	window_id: number;
	title: string;
	app_name: string;
	bundle_id: string;
	pid: number;
	bounds: { x: number; y: number; width: number; height: number };
}

interface ScreenshotDetails {
	path: string;
	window_id: number;
}

interface ActivationDetails {
	pid: number;
}

function isWindowInfo(value: unknown): value is WindowInfo {
	if (typeof value !== "object" || value === null) return false;
	const window = value as Record<string, unknown>;
	if (typeof window.bounds !== "object" || window.bounds === null) return false;
	const bounds = window.bounds as Record<string, unknown>;
	return (
		typeof window.window_id === "number" &&
		Number.isInteger(window.window_id) &&
		typeof window.title === "string" &&
		typeof window.app_name === "string" &&
		typeof window.bundle_id === "string" &&
		typeof window.pid === "number" &&
		Number.isInteger(window.pid) &&
		typeof bounds.x === "number" &&
		Number.isFinite(bounds.x) &&
		typeof bounds.y === "number" &&
		Number.isFinite(bounds.y) &&
		typeof bounds.width === "number" &&
		Number.isFinite(bounds.width) &&
		typeof bounds.height === "number" &&
		Number.isFinite(bounds.height)
	);
}

function encodeWindowList(windows: WindowInfo[]): string {
	const rows = windows.map((window) => ({
		window_id: window.window_id,
		title: window.title,
		app_name: window.app_name,
		bundle_id: window.bundle_id,
		pid: window.pid,
		x: window.bounds.x,
		y: window.bounds.y,
		width: window.bounds.width,
		height: window.bounds.height,
	}));
	const render = (count: number, omitted: number) =>
		encode(omitted === 0 ? { windows: rows.slice(0, count) } : { windows: rows.slice(0, count), omitted }, {
			indent: 1,
		});
	const fits = (value: string) =>
		Buffer.byteLength(value, "utf8") <= DEFAULT_MAX_BYTES && value.split("\n").length <= DEFAULT_MAX_LINES;
	const maximumRows = Math.max(0, DEFAULT_MAX_LINES - 2);

	if (rows.length <= maximumRows) {
		const full = render(rows.length, 0);
		if (fits(full)) return full;
	}

	let low = 0;
	let high = Math.min(rows.length, maximumRows);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fits(render(middle, rows.length - middle))) low = middle;
		else high = middle - 1;
	}
	return render(low, rows.length - low);
}

function registerAppshotTools(pi: ExtensionAPI, runHelper: RunHelper): void {
	const rowState = createToolRowStateStore(pi, "appshot.tool-row-state");

	pi.registerTool(
		defineTool<typeof listWindowsSchema, undefined>({
			name: "list_windows",
			label: "List Windows",
			description:
				"List visible normal macOS windows as compact TOON with window IDs, titles, application identity, process IDs, and bounds. Use list_windows to discover exact window IDs and application PIDs before screenshot_window or activate_app. Requires macOS 14 or newer and Screen & System Audio Recording permission.",
			parameters: listWindowsSchema,
			async execute(_toolCallId, _params, signal) {
				if (process.platform !== "darwin") throw new Error("list_windows is only available on macOS");
				const result = await runHelper(["list"], signal, 30_000);
				if (result.code !== 0)
					throw new Error(result.stderr.trim() || result.stdout.trim() || "Window listing failed");
				let parsed: unknown;
				try {
					parsed = JSON.parse(result.stdout);
				} catch {
					throw new Error("Window listing helper returned invalid data");
				}
				if (!Array.isArray(parsed) || !parsed.every(isWindowInfo)) {
					throw new Error("Window listing helper returned invalid data");
				}
				return { content: [{ type: "text", text: encodeWindowList(parsed) }], details: undefined };
			},
			renderCall(_args, theme, context) {
				rowState.watch(context.toolCallId, context.invalidate);
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				text.setText(formatToolRowTitle(rowState, context.toolCallId, "list_windows", theme));
				return text;
			},
			renderResult(result, _options, _theme, context) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				const content = result.content.find((item) => item.type === "text");
				text.setText(context.expanded && content?.type === "text" ? content.text : "");
				return text;
			},
		}),
	);

	pi.registerTool(
		defineTool<typeof screenshotWindowSchema, ScreenshotDetails | undefined>({
			name: "screenshot_window",
			label: "Screenshot Window",
			description:
				"Capture one visible macOS window by an exact ID returned by list_windows, resize it to fit within 1568×1568 pixels, save it to the required PNG path, and inspect the image. Call list_windows first.",
			parameters: screenshotWindowSchema,
			async execute(_toolCallId, params: ScreenshotWindowParams, signal, onUpdate, ctx) {
				if (process.platform !== "darwin") throw new Error("screenshot_window is only available on macOS");
				const rawPath = params.path.startsWith("@") ? params.path.slice(1) : params.path;
				if (!rawPath.trim()) throw new Error("Screenshot path cannot be empty");
				const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
				if (!absolutePath.toLowerCase().endsWith(".png")) throw new Error("Screenshot path must end in .png");

				await onUpdate?.({
					content: [{ type: "text", text: `Capturing window ${params.window_id}...` }],
					details: undefined,
				});
				return withFileMutationQueue(absolutePath, async () => {
					await mkdir(dirname(absolutePath), { recursive: true });
					const temporaryPath = join(dirname(absolutePath), `.${basename(absolutePath)}.${randomUUID()}.tmp.png`);
					try {
						const result = await runHelper(["capture", String(params.window_id), temporaryPath], signal, 30_000);
						if (result.code !== 0) {
							throw new Error(result.stderr.trim() || result.stdout.trim() || "Window capture failed");
						}
						let imageSize: number;
						try {
							imageSize = (await stat(temporaryPath)).size;
						} catch {
							throw new Error(result.stderr.trim() || "Window capture produced no PNG file");
						}
						if (imageSize > MAX_PNG_BYTES) {
							throw new Error(`Window capture exceeds the ${MAX_PNG_BYTES / 1024 / 1024} MiB attachment limit`);
						}
						const image = await readFile(temporaryPath);
						if (
							image.length < PNG_SIGNATURE.length ||
							!image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
						) {
							throw new Error("Window capture produced an invalid PNG file");
						}

						await rename(temporaryPath, absolutePath);
						return {
							content: [
								{ type: "text", text: `Captured window ${params.window_id} to ${absolutePath}` },
								{ type: "image", data: image.toString("base64"), mimeType: "image/png" },
							],
							details: { path: absolutePath, window_id: params.window_id },
						};
					} finally {
						await rm(temporaryPath, { force: true });
					}
				});
			},
		}),
	);

	pi.registerTool(
		defineTool<typeof activateAppSchema, ActivationDetails>({
			name: "activate_app",
			label: "Activate App",
			description:
				"Bring a running macOS application and its windows to the foreground by a process ID returned by list_windows. Use only when foregrounding is required for visual validation because activate_app changes user focus.",
			parameters: activateAppSchema,
			async execute(_toolCallId, params, signal) {
				if (process.platform !== "darwin") throw new Error("activate_app is only available on macOS");
				const result = await runHelper(["activate", String(params.pid)], signal, 5000);
				if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Activation failed");
				return {
					content: [{ type: "text", text: `Activated application PID ${params.pid}` }],
					details: { pid: params.pid },
				};
			},
		}),
	);

	pi.on("session_start", () => rowState.clear());
}

export default function appshotExtension(pi: ExtensionAPI): void {
	registerAppshotTools(pi, createNativeHelper(pi));
}
