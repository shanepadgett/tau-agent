# Tool Approval

Reviews agent `bash` and `script_runner` requests before they run, so routine development work proceeds and consequential or hard-to-reverse actions wait for you.

Common read-only bash commands skip review. Everything else goes to a separate reviewer model. It approves routine, low-impact work: project edits, builds, tests, type checks, read-only service requests such as Jira or Confluence lookups, additive writes such as creating a page or draft, and normal authentication with existing credentials. Approval depends on what a request does, not on its language or tool. The reviewer asks you before meaningful data loss, disruptive production or system changes, access or privilege changes, exposure of secrets or sensitive data, substantial payments, or consequential publication. Code the reviewer cannot see is not a reason to ask.

When a request runs a local script, Tau reads that script within a small budget so the reviewer can see what it does. This is a risk filter, not a sandbox. If an inspected file changes after review, the approval no longer applies and the agent must resubmit the request.

When approval is required, Tau shows a plain-language explanation of what you are allowing, who or what is affected, the risk, and how hard recovery may be. For `script_runner`, you also see the full script. If the reviewer fails, Tau asks you directly and sends an attention notification.

With `autoApprove` enabled, reviewer-approved requests run without another confirmation, and Tau shows a marker with the reviewer model. Tau uses the reviewer model for the current provider, then the current chat model if that fails.

Each handled request is recorded privately in the session history. The records stay out of model context and do not copy commands, scripts, file contents, or notes.

In the terminal approval panel, move between Approve and Reject, press `j` or `k` to scroll a script, press `n` to add a note to the highlighted choice, then press Enter to choose. Escape cancels note editing or blocks the request. A rejection note tells the agent why the request was blocked. An approval note reaches the agent with the tool result without changing the request. To ask for a different request, reject it with a note. RPC clients use the standard confirmation dialog without notes.

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
