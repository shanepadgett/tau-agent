# Standards and AGENTS.md

- Every change to `AGENTS.md` or `docs/standards/` needs the user's approval. Show the exact text you intend to change and wait. A direct request from the user to make that change is the approval.

## AGENTS.md

- It holds two things only: the standards table and global rules that apply to all work.
- Each rule is one or two plain sentences. Use simple headings and no nested lists.
- Add a rule only if it applies to all work. Anything narrower goes in a standard.
- Do not grow it for completeness. Remove rules that no longer apply.

## Standards

- Anything a tool can check deterministically is a check, not a standard. Standards cover only what tools cannot check, kept short, where knowing the rule up front saves rework.
- One file per area, split by code boundary (such as a layer) or type of work (such as testing).
- A standard holds only its rules. When to read it lives in the table's "Read when" column, not in the file.
- "Read when" names an action ("Changing X", "Adding Y"), never a topic, so agents read the standard only when acting on it.
- Add or remove the table row in the same change that adds or deletes the standard.
- Write short bullet rules. State the rule, not its history. Add an example only when the rule is unclear without one.
- Each rule lives in one standard. Check for an existing home before adding it.
