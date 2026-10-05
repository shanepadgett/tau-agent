# Tool Loader

Tau registers specialist tool groups out of every request. Most coding turns do not need web, image, macOS application, or application-specific schemas.

Deferred groups load through Pi's built-in `tool_search` tool, which Tau keeps active whenever deferred tools exist. The `web` group uses `codemode` exposure instead: its tools are listed by the codemode tool and called from code mode scripts, never declared to the model. Tau keeps `codemode` active whenever a codemode-exposure group exists, and warns when either built-in extension is disabled.

Tau's built-in groups are:

- `web` for public web research, reached through code mode
- `image` for raster image generation and editing, deferred
- `appshot` for macOS window discovery, capture, and activation, deferred

Project and global package extensions can add groups with `registerToolGroup()` from `@shanepadgett/tau-agent`. The group id and description become the tool namespace shown to the agent.

Tau adds a short `deferred-tools` section to the system prompt that lists each deferred group with its description, so the agent knows what it can load without guessing search terms. The section changes only when a group is added or removed. Codemode groups are listed by the codemode tool itself.

Loaded tools are recorded in the session and stay available on that branch. All models can discover and load deferred tools. Supported models preserve the cached prompt prefix; other models, including Grok and opencode-go, can incur a cache miss when tools are activated. Tau does not compact automatically.

Pi's built-in `tool_search` and `codemode` extensions must be enabled. After changing this extension during development, run `/reload` before testing.
