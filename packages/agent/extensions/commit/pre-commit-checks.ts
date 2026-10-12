import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BoundedTextResultBuilder } from "../../shared/bounded-text-result.ts";
import { emitTauEvent } from "../../shared/events.ts";
import type { GitRunner } from "../../shared/git.ts";
import type { TemporaryOutputStore } from "../../shared/temporary-output-store.ts";
import { errorText } from "../../shared/text.ts";
import { computeWorktreeSignature, type DirtyFile } from "./git-change-set.ts";

const MESSAGE_TYPE = "tau.commit.pre-commit-checks";

/** Runs registered pre-commit checks once. Returns false after reporting failures to the agent. */
export async function runPreCommitChecks(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	store: TemporaryOutputStore,
	signal: AbortSignal,
	git: GitRunner,
	root: string,
	worktree: { files: readonly DirtyFile[]; signature: string },
): Promise<boolean> {
	const checks: { source: string; check: Promise<{ passed: boolean; text: string }> }[] = [];
	emitTauEvent(pi, "tau:commit.before", {
		cwd: ctx.cwd,
		signal,
		waitFor: (source, check) => checks.push({ source, check }),
	});
	if (checks.length === 0) return true;

	const results = await Promise.allSettled(checks.map((entry) => entry.check));
	signal.throwIfAborted();
	if ((await computeWorktreeSignature(git, root, worktree.files)) !== worktree.signature) {
		throw new Error("Pre-commit checks changed the working tree. Review the changes and run /commit again.");
	}
	const failures = results.flatMap((result, index) => {
		const source = checks[index]?.source ?? "unknown";
		if (result.status === "rejected") return [{ source, text: errorText(result.reason) }];
		return result.value.passed ? [] : [{ source, text: result.value.text }];
	});
	if (failures.length === 0) return true;

	// Tail retention keeps the closing instruction when listener output overflows.
	const output = new BoundedTextResultBuilder(store, "tail");
	try {
		for (const failure of failures) await output.append(`## ${failure.source}\n\n${failure.text.trim()}\n\n`);
		await output.append(
			"Pre-commit checks failed during /commit, so nothing was committed. Fix the failures, then ask the user to run /commit again.",
		);
		const result = await output.finish();
		ctx.ui.notify(
			`Pre-commit checks failed: ${failures.map((failure) => failure.source).join(", ")}. Sent to the agent.`,
			"error",
		);
		void pi.sendMessage({ customType: MESSAGE_TYPE, content: result.content, display: true }, { triggerTurn: true });
		return false;
	} catch (error) {
		await output.abort();
		throw error;
	}
}
