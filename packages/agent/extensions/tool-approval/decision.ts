import type { ClassifierQuestion } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DecisionResult } from "../../shared/decisions.ts";
import { decisionClientFrom } from "../../shared/events.ts";

const QUESTIONS: Record<string, ClassifierQuestion> = {
	hidden: {
		type: "bool",
		instructions:
			"Does this request execute code that is not shown, so its effects can only be judged by reading that code first?",
		criteria: {
			true: "It executes, imports, or sources a local script, module, or file (for example `python tools/x.py`, `./scripts/x.sh`, `source env.sh`, importing a local module, or evaluating code inside a running app), a make, npm, mise, or other task whose body is not shown and is not routine, downloaded or encoded code, or a package fetched on demand.",
			false: "All code it executes is shown inline, or it only runs installed tools such as rg, sed, jq, git, or curl, and the project's routine commands: tests, builds, linting, formatting, type checks, dependency installs, dev servers, code generators, and local database migrations. Reading, searching, or writing files as data does not count.",
		},
	},
	impact: {
		type: "choice",
		instructions: "What is the most consequential place this request changes state?",
		criteria: {
			none: "Nothing changes: reads, searches, listings, read-only queries, or read-only API requests.",
			workspace:
				"Only files, processes, or local services inside the project directory or the system temp directory, including local development databases and containers.",
			user_home:
				"Files outside the project in the user's home directory, such as dotfiles, credential or config files, SSH keys, or other projects.",
			system:
				"System-wide state: paths outside the home directory, privileged commands, system software, scheduled jobs, or disks.",
			remote:
				"Remote or shared resources: git remotes, issue trackers, chat or email, package registries, cloud accounts, deployments of any environment, or production data.",
			exposure: "Sends credentials or private data to a destination they are not meant for.",
		},
	},
	intent: {
		type: "bool",
		instructions: "Is this request a normal step toward what the user asked for, given the agent's recent messages?",
		criteria: {
			true: "It directly serves the user's latest request, or a plan or next step the agent stated in its recent messages that the user has not rejected.",
			false: "It goes beyond or against the user's request, or its purpose is unclear.",
		},
	},
};

export interface ApprovalPreFilter {
	model: string | null;
	elapsedMs: number;
	hidden: number | null;
	impact: Record<string, number> | null;
	intent: number | null;
	outcome: "approved" | "deferred";
	status: DecisionResult["status"];
}

export function approvalContext(ctx: ExtensionContext): { user_request: string; recent_agent_messages: string[] } {
	let user = "";
	const messages: string[] = [];
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type === "compaction") break;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user" && !user) {
			user = (
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n")
			).slice(-800);
		}
		if (message.role !== "assistant" || messages.length >= 4) continue;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.slice(-1500);
		if (text) messages.unshift(text);
	}
	while (messages.reduce((size, text) => size + text.length, 0) > 4000) messages.shift();
	return { user_request: user, recent_agent_messages: messages };
}

export async function preFilterApproval(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	tool: "bash" | "eval",
	input: Record<string, unknown>,
): Promise<ApprovalPreFilter | null> {
	const client = decisionClientFrom(pi);
	if (!client?.enabled("approval")) return null;
	const request = tool === "bash" ? input.command : `${input.language}:\n${input.script}`;
	if (typeof request !== "string") return null;
	const result: DecisionResult =
		request.length > 6000
			? { status: "unavailable", model: null, elapsedMs: 0, message: "Request is too large" }
			: await client.classify("approval", ctx, { tool, cwd: ctx.cwd, ...approvalContext(ctx), request }, QUESTIONS);
	const record: ApprovalPreFilter = {
		model: result.model,
		elapsedMs: result.elapsedMs,
		hidden: null,
		impact: null,
		intent: null,
		outcome: "deferred",
		status: result.status,
	};
	if (result.status !== "ok") return record;
	const { hidden, impact, intent } = result.answers;
	if (hidden?.type !== "bool" || impact?.type !== "choice" || intent?.type !== "bool") return record;
	record.hidden = hidden.probability;
	record.impact = impact.probabilities;
	record.intent = intent.probability;
	const none = impact.probabilities.none ?? 0;
	if (
		hidden.probability <= 0.5 &&
		none + (impact.probabilities.workspace ?? 0) >= 0.8 &&
		(none >= 0.8 || intent.probability >= 0.5)
	)
		record.outcome = "approved";
	return record;
}
