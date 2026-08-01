import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveProjectRoot } from "../../shared/settings/paths.ts";
import { errorText } from "../../shared/text.ts";
import { type ReadyFormat, localTimestampSlug, summarizeCounts } from "./model.ts";
import { readyFileExtension, renderReadyReport } from "./render.ts";
import { scanReadyReport } from "./scan.ts";

const OUTPUT_DIR = join(".pi", "tau", "ready");

export default function readyExtension(pi: ExtensionAPI): void {
	pi.registerCommand("ready", {
		description: "Scan agent readiness and write a markdown or HTML report",
		handler: async (_args, ctx) => {
			try {
				await runReady(ctx);
			} catch (error) {
				ctx.ui.notify(`/ready failed: ${errorText(error)}`, "error");
			}
		},
	});
}

async function runReady(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.isProjectTrusted()) {
		ctx.ui.notify("/ready requires a trusted project", "warning");
		return;
	}

	const format = await pickFormat(ctx);
	if (!format) return;

	const root = await resolveProjectRoot(ctx.cwd);
	const report = await scanReadyReport(ctx.cwd);
	const body = renderReadyReport(report, format);
	const stamp = localTimestampSlug(new Date(report.generatedAt));
	const fileName = `ready-${stamp}.${readyFileExtension(format)}`;
	const outDir = join(root, OUTPUT_DIR);
	const outPath = join(outDir, fileName);

	await mkdir(outDir, { recursive: true });
	await writeFile(outPath, body, "utf8");

	const displayPath = relative(ctx.cwd, outPath) || outPath;
	ctx.ui.notify(`/ready ${summarizeCounts(report.counts)}\n${displayPath}`, "info");
}

async function pickFormat(ctx: ExtensionCommandContext): Promise<ReadyFormat | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/ready needs the TUI to choose Markdown or HTML", "warning");
		return undefined;
	}
	const selected = await ctx.ui.select("Ready report format", ["Markdown", "HTML"]);
	if (selected === "Markdown") return "markdown";
	if (selected === "HTML") return "html";
	return undefined;
}
