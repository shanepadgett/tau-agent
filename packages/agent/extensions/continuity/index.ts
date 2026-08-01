import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { setContinuityRowsVisible } from "../../shared/continuity-visibility.ts";
import { CHECKPOINT_TOOL, registerCheckpointTool } from "./checkpoint.ts";
import { createCheckpointBudget, type CheckpointBudgetNoticeLevel } from "./checkpoint-budget.ts";
import { projectContextMessages } from "./messages.ts";
import { CONTINUITY_SYSTEM_GUIDANCE, formatContinuityMessage } from "./prompt.ts";
import continuitySettings from "./settings.ts";

export default function continuityExtension(pi: ExtensionAPI): void {
	const budget = createCheckpointBudget();
	let checkpointSucceeded = false;

	const resetBudget = (): void => {
		checkpointSucceeded = false;
		budget.reset();
	};

	registerCheckpointTool(pi);
	pi.on("session_start", async (_event, ctx) => {
		const settings = await loadTauExtensionSettings(ctx, continuitySettings);
		budget.configure(settings.checkpointTokenLimit);
		setContinuityRowsVisible(settings.showToolRows);
	});
	pi.on("session_shutdown", () => {
		setContinuityRowsVisible(false);
		resetBudget();
	});
	pi.on("session_compact", resetBudget);
	pi.on("session_tree", resetBudget);
	pi.on("session_before_fork", resetBudget);
	pi.on("session_before_switch", resetBudget);
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${CONTINUITY_SYSTEM_GUIDANCE}`,
	}));
	pi.on("turn_start", (_event, ctx) => {
		if (checkpointSucceeded) resetBudget();
		const noticeLevel = budget.beginTurn(ctx.getContextUsage()?.tokens ?? null);
		if (noticeLevel !== undefined) sendCheckpointBudgetNotice(pi, noticeLevel);
	});
	pi.on("turn_end", (_event, ctx) => {
		if (checkpointSucceeded) {
			resetBudget();
			return;
		}
		const noticeLevel = budget.finishTurn(ctx.getContextUsage()?.tokens ?? null);
		if (noticeLevel !== undefined) sendCheckpointBudgetNotice(pi, noticeLevel);
	});
	pi.on("tool_result", (event) => {
		if (event.toolName === CHECKPOINT_TOOL && !event.isError) checkpointSucceeded = true;
	});
	pi.on("tool_call", (event) => {
		if (!budget.shouldBlockTool(event.toolName, CHECKPOINT_TOOL)) return;
		return {
			block: true,
			reason: formatContinuityMessage(
				"block",
				"Checkpoint required before using other tools. Call checkpoint, then continue the user's work.",
			),
		};
	});
	pi.on("context", (event, ctx) => ({
		messages: projectContextMessages(event.messages, ctx.sessionManager.buildContextEntries()),
	}));
}

function sendCheckpointBudgetNotice(pi: ExtensionAPI, level: CheckpointBudgetNoticeLevel): void {
	pi.sendMessage({
		customType: "tau.continuity",
		content: checkpointBudgetMessage(level),
		display: false,
		details: {
			v: 1,
			kind: "continuity.checkpoint-budget",
			source: "continuity",
			level,
		},
	});
}

function checkpointBudgetMessage(level: CheckpointBudgetNoticeLevel): string {
	switch (level) {
		case 50:
			return formatContinuityMessage(
				"budget",
				"Context usage reached 50% of the configured continuity checkpoint limit. Continue current work and checkpoint when convenient.",
				{ level: "50" },
			);
		case 75:
			return formatContinuityMessage(
				"budget",
				"Context usage reached 75% of the configured continuity checkpoint limit. Run checkpoint soon. At 100%, non-checkpoint tool calls will be blocked until checkpoint succeeds.",
				{ level: "75" },
			);
		case 100:
			return formatContinuityMessage(
				"budget",
				"Checkpoint budget reached. Call checkpoint now before using any other tool. Do not call other tools.",
				{ level: "100" },
			);
	}
}
