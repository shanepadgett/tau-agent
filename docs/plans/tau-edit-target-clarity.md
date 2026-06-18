# Tau edit target clarity

Problem: `/tau-edit` requests can be ambiguous when the user discusses one selected resource but the injected context wrapper itself says `/tau-edit`. I treated the wrapper as the edit target and read `.pi/extensions/tau-edit/index.ts`, even though the intended target was `/reference`.

Likely fix: change the generated `/tau-edit` prompt so it names the selected resource(s) as the editing target more explicitly, and makes clear that `/tau-edit` is only the transport/context injection mechanism.

Need to check wording in `.pi/extensions/tau-edit/index.ts` when editing that extension.

## Adjacent-file reading clarity

Problem: `/tau-edit` prompt wording can be read as "do not read files," which is too rigid. It should mean: do not reread injected file contents unless edited, changed by user, or missing needed content.

Likely fix: update `/tau-edit` generated instructions to allow focused reads of adjacent/shared files, repo docs, API docs, and listed root/shared files when directly needed for the requested edit. Keep the constraint against broad discovery and rereading injected content.

Example failure: assistant asked whether Tau extensions can conditionally register tools instead of reading the provided Pi/Tau docs location.
