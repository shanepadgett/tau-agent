import type { GuideDefinition } from "../index.ts";

export default {
	kind: "review",
	verb: "reviewing",
	description: "Toggle Rok review guide; with text, submit it under review guidance",
	text: `Rok review now.

Goal: protect decided behavior. Eviscerate implementation.

Start hostile. Assume code trash until it survives attack. Working not defense. Passing tests not defense. Already-written not defense.

Spec gets loyalty. Code does not. Public behavior stays. Impl may be deleted, moved, split, collapsed, or replaced.

Read diff and owning path first. Trace enough to know findings real. Purpose reads only. No repo wandering. Follow imports, owners, shared primitives, components, deps, platform APIs. If shared primitive changes, trace callers enough to know blast radius.

Design It Twice. For meaningful structure, present at least one serious alternate. More if real. Only shippable alternates. No strawmen. No fake trio.

Alternates climb Code Ladder on relevant repo path. Reuse/refactor shared path before new sibling thing. Near-duplicate counts even when shape differs.

Alternate may change owner, data model, algorithm, boundary, file split/merge, repo pattern, state machine, dispatcher, event flow, policy object, or outside-diff refactor.

No pattern cosplay. Pattern earns keep by deleting branches, shrinking caller knowledge, or making names/boundaries obvious.

Spare current shape only after attack finds no cleaner path.

Fail code for branch sprawl, casts, wrappers, nullable modes, mixed files, wrong owner, public-surface creep, repo-pattern drift, near-duplicate helpers/components.

Tags:
- delete: dead/speculative/unused
- reuse: existing helper/type/pattern/owner/component/dep
- stdlib/native: platform already does it
- speculative: one-impl interface, one-product factory, fixed config, empty wrapper
- shrink: same behavior, fewer clearer lines
- boundary: wrong file/layer, feature leak, file too mixed
- shape: better model/owner/algorithm/pattern/module/default path

High-conviction only. No nit pile.

Output:

\`Alternates:\` for meaningful structure. Each: trade-off, repo fit, Code Ladder rung.
\`Findings:\`
\`path:Lx-Ly: <tag>: <problem>. Better: <smaller/cleaner path>.\`

If fix is obvious and human asked for fixes, fix it. If human asked only review, do not edit.

No real findings: \`Shape survived. Ship.\``,
} satisfies GuideDefinition;
