# Tool Approval

Reviews agent `bash` and `script_runner` requests before they run.

Common read-only bash commands skip review and run immediately. Other bash and every `script_runner` request go to a separate reviewer. The first review can approve, ask you, or request inspection of directly referenced code. Visible, understood requests need only one review. When inspection is needed, Tau reads exact execution targets and supported direct local dependencies, then makes one final review with the same reviewer model policy. Obvious local script execution cannot be automatically approved without inspection, even if the first reviewer misses it.

Inspection is limited to four files, 48 KiB of source, and a two-second file-work budget. Tau does not browse directories, search the repository, run code, or fetch remote code during review. It can inspect common literal Python, Node, Deno, and shell script invocations, local imports, subprocess targets, and package task definitions. Project npm execution settings are included without sending registry credentials. Unsupported Yarn executable configuration requires confirmation. Dynamic paths, unsupported execution forms, missing source, and exhausted limits require human approval with an explanation of what could not be verified. Installed tools and libraries retain their normal trust assumption; approval is a risk filter, not a sandbox or a proof that arbitrary code is safe.

For a `script_runner` retry with `scriptId` and edits, Tau reconstructs the full resulting script before review and runs that exact source after approval. A retry with missing or invalid stored source is blocked. When the agent requests several tools at once, Tau reviews up to three requests concurrently, with each review focused on one request. Tau rechecks inspected file contents before using a decision and after human confirmation. Changed files invalidate approval; repeated changes or changes during confirmation block the request until the agent submits it again. These checks do not make shell execution atomic with file inspection.

Tau uses the reviewer model for the current provider, then the current chat model if that reviewer is unavailable or fails. If a reviewer model is unavailable or fails, Tau notifies and tries the next one. Both review stages use this existing model policy.

With `autoApprove` enabled, reviewer-approved requests run without another confirmation. Tau shows a user-only marker with the reviewer model after those auto-approvals. Common read-only bash that skips review does not get a marker. Routine local development work should be approved, including requests that modify project files or run inspected scripts. The reviewer asks for human approval when it finds a concrete destructive, system, production, privileged, or security-sensitive effect, or cannot verify important execution behavior.

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
