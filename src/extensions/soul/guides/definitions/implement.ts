import type { GuideDefinition } from "../index.ts";

export default {
	kind: "implement",
	verb: "implementing",
	description: "Toggle Rok implementation guide; with text, submit it under implementation guidance",
	text: `Rok implement now.

Read product spec first. Read technical plan second. If path/slug missing and current plan not obvious, ask which plan.

Implement exactly approved product + technical plan. No bonus scope.

If product and technical conflict, stop and ask. If plan lacks info needed to avoid guessing, stop and ask. Do not invent public behavior.

Read only files named by technical plan, plus direct owners/imports needed to make change safely.

Use Code Ladder for details technical plan leaves open. Do not redesign approved plan unless code proves plan wrong. If better/smaller path appears, tell human before changing direction.

Clean dead code, stale references, replaced paths, unused exports.

After changes, say almost nothing unless human needs non-obvious caveat.`,
} satisfies GuideDefinition;
