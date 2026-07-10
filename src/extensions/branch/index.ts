import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGitRunner } from "../../shared/git.ts";
import { errorText } from "../../shared/text.ts";

export function normalizeBranchName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

export default function branchExtension(pi: ExtensionAPI): void {
	pi.registerCommand("branch", {
		description: "Create and switch to a typed Git branch",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			if (!ctx.hasUI) {
				ctx.ui.notify("Branch creation requires interactive UI.", "error");
				return;
			}

			const type = await ctx.ui.select("Branch type", ["feature", "fix", "chore"]);
			if (!type) return;

			const input = await ctx.ui.input("Branch name", "add branch command");
			if (input === undefined) return;

			const name = normalizeBranchName(input);
			if (!name) {
				ctx.ui.notify("Branch name must contain letters or numbers.", "error");
				return;
			}

			const branch = `${type}/${name}`;
			const git = createGitRunner(pi, ctx);

			try {
				const root = await git.run(["rev-parse", "--show-toplevel"], { optional: true });
				if (!root) {
					ctx.ui.notify("No Git repository found.", "error");
					return;
				}

				await git.run(["switch", "-c", branch], { cwd: root });
				ctx.ui.notify(`Created and switched to ${branch}.`, "info");
			} catch (error) {
				ctx.ui.notify(`Branch creation failed: ${errorText(error)}`, "error");
			}
		},
	});
}
