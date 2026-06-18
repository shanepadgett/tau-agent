# Tau edit target clarity

Problem: `/tau-edit` requests can be ambiguous when the user discusses one selected resource but the injected context wrapper itself says `/tau-edit`. I treated the wrapper as the edit target and read `.pi/extensions/tau-edit/index.ts`, even though the intended target was `/reference`.

Likely fix: change the generated `/tau-edit` prompt so it names the selected resource(s) as the editing target more explicitly, and makes clear that `/tau-edit` is only the transport/context injection mechanism.

Need to check wording in `.pi/extensions/tau-edit/index.ts` when editing that extension.
