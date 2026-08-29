import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildCostReport } from "./analyze.ts";
import { renderCostReportHtml } from "./html.ts";
import { CostReportStatusPanel } from "./panel.ts";
import { LIVE_RANGE_CHOICES, liveRange, MONTH_CHOICES, specificMonthRange, yearChoices } from "./range.ts";
import type { ReportRange, ReportScope } from "./types.ts";

const COMMAND = "cost-report";

export default function costReportExtension(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND, {
		description: "Generate an HTML cost report from local sessions",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/cost-report requires TUI mode", "warning");
				return;
			}

			await ctx.waitForIdle();

			const range = await pickRange(ctx);
			if (!range) return;

			const scope = await pickScope(ctx);
			if (!scope) return;

			const secondary = `${range.label} · ${scope === "project" ? "Current project" : "All sessions"}`;

			const path = outputPath(range, scope);
			if (await fileExists(path)) {
				try {
					await openReport(pi, ctx, path);
				} catch {
					// Still notify the path if the OS open fails.
				}
				ctx.ui.notify(`Opening existing cost report · ${path}`, "info");
				return;
			}

			const outcome = await ctx.ui.custom<
				| { kind: "ok"; path: string }
				| { kind: "empty" }
				| { kind: "cancelled" }
				| { kind: "error"; message: string }
			>((tui, theme, _keys, done) => {
				const panel = new CostReportStatusPanel(tui, theme, secondary);
				void (async () => {
					try {
						const report = await buildCostReport({
							cwd: ctx.cwd,
							range,
							scope,
							signal: panel.signal,
							onProgress: (status) => panel.update(status),
						});
						if (panel.signal.aborted) {
							done({ kind: "cancelled" });
							return;
						}
						if (!report) {
							done({ kind: "empty" });
							return;
						}

						panel.update("Writing file…");
						await mkdir(join(homedir(), ".pi", "tau", "cost-reports"), { recursive: true });
						await writeFile(path, renderCostReportHtml(report), "utf8");

						if (panel.signal.aborted) {
							done({ kind: "cancelled" });
							return;
						}

						panel.update("Opening…");
						try {
							await openReport(pi, ctx, path);
						} catch {
							// File is written; notify still carries the path if open fails.
						}
						done({ kind: "ok", path });
					} catch (error) {
						if (panel.signal.aborted) {
							done({ kind: "cancelled" });
							return;
						}
						done({
							kind: "error",
							message: error instanceof Error ? error.message : String(error),
						});
					} finally {
						panel.dispose();
					}
				})();
				return panel;
			});

			if (outcome.kind === "ok") {
				ctx.ui.notify(`Cost report written · ${outcome.path}`, "info");
				return;
			}
			if (outcome.kind === "empty") {
				ctx.ui.notify(`No session spend found for ${secondary}.`, "warning");
				return;
			}
			if (outcome.kind === "cancelled") {
				ctx.ui.notify("Cost report cancelled.", "info");
				return;
			}
			ctx.ui.notify(`Unable to build cost report: ${outcome.message}`, "error");
		},
	});
}

async function pickRange(ctx: ExtensionCommandContext): Promise<ReportRange | undefined> {
	const choice = await ctx.ui.select(
		"Time frame",
		LIVE_RANGE_CHOICES.map((item) => item.label),
	);
	if (!choice) return undefined;

	const selected = LIVE_RANGE_CHOICES.find((item) => item.label === choice);
	if (!selected) return undefined;
	if (selected.id !== "specific-month") return liveRange(selected.id);

	const monthLabel = await ctx.ui.select(
		"Month",
		MONTH_CHOICES.map((item) => item.label),
	);
	if (!monthLabel) return undefined;
	const month = MONTH_CHOICES.find((item) => item.label === monthLabel);
	if (!month) return undefined;

	const years = yearChoices().map(String);
	const yearLabel = await ctx.ui.select("Year", years);
	if (!yearLabel) return undefined;
	const year = Number(yearLabel);
	if (!Number.isFinite(year)) return undefined;

	return specificMonthRange(year, month.month);
}

async function pickScope(ctx: ExtensionCommandContext): Promise<ReportScope | undefined> {
	const choice = await ctx.ui.select("Scope", ["Current project", "All sessions"]);
	if (choice === "Current project") return "project";
	if (choice === "All sessions") return "all";
	return undefined;
}

function outputPath(range: ReportRange, scope: ReportScope): string {
	// One file per window identity + scope. Re-running the same picks reopens this path.
	return join(homedir(), ".pi", "tau", "cost-reports", `cost-report-${range.slug}-${scope}.html`);
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function openReport(pi: ExtensionAPI, ctx: ExtensionCommandContext, path: string): Promise<void> {
	const command = openCommand(path);
	const result = await pi.exec(command.command, command.args, {
		signal: ctx.signal,
		timeout: 5_000,
	});
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `open command failed with exit ${result.code}`);
	}
}

function openCommand(path: string): { command: string; args: string[] } {
	if (process.platform === "darwin") return { command: "open", args: [path] };
	if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", path] };
	return { command: "xdg-open", args: [path] };
}
