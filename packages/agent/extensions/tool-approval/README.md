# Tool Approval

Reviews agent `bash` and `script_runner` requests before they run.

Common read-only bash commands skip review and run immediately. Other bash and every `script_runner` request go to a separate reviewer. The first review can approve, ask you, or request inspection of directly referenced code. Visible, understood requests need only one review. When inspection is needed, Tau reads exact execution targets and supported direct local dependencies, then makes one final review with the same reviewer model policy. Obvious local script execution cannot be automatically approved without inspection, even if the first reviewer misses it.

Inspection is limited to four files, 48 KiB of source, and a two-second file-work budget. Tau does not browse directories, search the repository, run code, or fetch remote code during review. It can inspect common literal Python, Node, Deno, and shell script invocations, local imports, subprocess targets, and package task definitions. Project npm execution settings are included without sending registry credentials. Missing executable source, unchecked execution targets, and unresolved code-loading configuration, including unsupported Yarn executable configuration, require confirmation. Other inspection gaps are not automatic reasons to ask: the reviewer can approve when the visible request and inspected code establish routine, low-impact effects. It asks when dynamic execution, exhausted limits, or other missing information leave executable code or a substantial risk unresolved. Installed tools and libraries retain their normal trust assumption; approval is a risk filter, not a sandbox or a proof that arbitrary code is safe.

For a `script_runner` retry with `scriptId` and edits, Tau reconstructs the full resulting script before review and runs that exact source after approval. A retry with missing or invalid stored source is blocked. When the agent requests several tools at once, Tau reviews up to three requests concurrently, with each review focused on one request. Tau rechecks inspected file contents before using a decision and after human confirmation. Changed files invalidate approval; repeated changes or changes during confirmation block the request until the agent submits it again. These checks do not make shell execution atomic with file inspection.

Tau uses the reviewer model for the current provider, then the current chat model if that reviewer is unavailable or fails. If a reviewer model is unavailable or fails, Tau notifies and tries the next one. Both review stages use this existing model policy.

Each handled request saves a private decision record in the session JSONL under `tau.tool-approval.decision`. Records include the tool-call ID, tool name, approval or block decision, decision source and reason, review stages and reviewer models, inspected paths, evidence-gap categories, and elapsed time. They also cover allowlist skips, disabled approval, failed reviews, cancellations, and user rejection. These records are excluded from model context and follow the session's storage and deletion lifecycle. They do not copy command arguments, scripts, file contents, reviewer explanations, approval notes, or raw errors. Inspected paths are retained, so file names remain visible in the session.

With `autoApprove` enabled, reviewer-approved requests run without another confirmation. Tau shows a user-only marker with the reviewer model after those auto-approvals. Common read-only bash that skips review does not get a marker. Routine, low-impact work should be approved locally and in external services. This includes project file edits, inspected scripts, read-only Jira or Confluence requests, and creating documents, pages, drafts, or records without replacing valuable content or causing consequential side effects. Reading an environment token and using it to authenticate with its intended service is normal authentication, not secret disclosure. An external destination, a write, or the use of a credential alone is not a reason to ask.

The reviewer asks before meaningful data loss, difficult-to-recover overwrites, disruptive production or system changes, elevated privileges or access/security changes, credential exposure, sensitive-data disclosure to unintended audiences, substantial payments, or consequential publication, messages, and workflows. Additive writes still require confirmation if they change access, expose private material, or trigger hard-to-reverse effects. Deleting a public post cannot undo disclosure; deleting a record cannot undo a message or charge it already triggered. Ordinary internal document creation does not count as consequential publication by itself. Missing information requires confirmation when it leaves executable code or one of these substantial risks unresolved, not merely because every implementation detail or response field is unknown.

When approval is required, Tau shows one plain-language paragraph explaining what you are allowing, who or what is affected, why approval is needed, and what recovery might involve. It summarizes consequences rather than listing script steps or specialized APIs. If the issue is missing evidence rather than a known danger, it says what could not be checked. For `script_runner`, human confirmation also shows the complete script that will run. If several requests need approval, their confirmation windows open one at a time. If the reviewer fails or returns a malformed decision, Tau asks for direct human approval instead of running it automatically. Tau also sends an attention notification when the approval window opens.

In the terminal approval panel, move between Approve and Reject, press `j` or `k` to scroll a script, press `n` to add a note to the highlighted choice, then press Enter to choose. Enter saves an edited note before choosing; Escape cancels note editing or blocks the request from the choice list. A rejection note tells the agent why the request was blocked. An approval note reaches the agent with the tool result; it does not change the request being approved. To ask for a different request, reject it with a note. Long notes are truncated. RPC clients use the standard confirmation dialog without notes.

Configure under `extensions.toolApproval`:

```json
{
  "extensions": {
    "toolApproval": {
      "enabled": true,
      "autoApprove": true
    }
  }
}
```
