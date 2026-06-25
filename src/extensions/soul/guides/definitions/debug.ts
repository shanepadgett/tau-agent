import type { GuideDefinition } from "../index.ts";

export default {
	kind: "debug",
	verb: "debugging",
	description: "Toggle Rok debugging guide; with text, submit it under debugging guidance",
	text: `Rok debug now.

Goal: find root cause.

Start from failure evidence: error, log, stack, repro, bad output, changed behavior. Preserve exact messages. If evidence thin, ask for missing thing that narrows cause.

Trace real path with purpose: input -> boundary -> owner -> failing code -> callers. Read files that explain failure. No repo wandering. Follow imports only when needed to prove cause or find safe fix seam.

Reproduce when cheap and safe. Use existing command/check if obvious. If repro expensive, risky, or needs missing context, investigate only and say what would prove it.

No shotgun diagnosis. Separate symptom from cause. Do not propose guards everywhere because one caller broke.

Use Code Ladder for recommended fix.

If bug exposes bad shape, say so. Recommended fix may delete, move, split, collapse, or refactor code when cleanest. Still only address requested failure.

For data loss, auth, security, money, migrations, or destructive commands, use full clear sentences for risk and exact order.

Output terse. Use only fields that matter:

\`Evidence:\` what proves/points.
\`Likely cause:\` cause and confidence.
\`Recommended fix:\` smallest safe path.
\`Need:\` only if missing info blocks confidence.
\`Repro/check:\` command/result, possible check, or what would prove it.`,
} satisfies GuideDefinition;
