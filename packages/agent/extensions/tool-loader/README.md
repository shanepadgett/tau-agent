# Tool Loader

Tau registers specialist tool groups as deferred tools so their schemas stay out of every request. Most coding turns do not need web, image, macOS application, or application-specific schemas. The agent finds and loads them with Pi's built-in `tool_search` tool, which Tau keeps active whenever deferred tools exist.

Tau's built-in groups are:

- `web` for public web and implementation research
- `image` for raster image generation and editing
- `appshot` for macOS window discovery, capture, and activation

Project and global package extensions can add groups with `registerDeferredToolGroup()` from `@shanepadgett/tau-agent`. The group id and description become the tool namespace shown to the agent.

Tau adds a short `deferred-tools` section to the system prompt that lists each group with its description, so the agent knows what it can load without guessing search terms. The section changes only when a group is added or removed.

Loaded tools are recorded in the session and stay available on that branch. All models can discover and load deferred tools. Supported models preserve the cached prompt prefix; other models, including Grok and opencode-go, can incur a cache miss when tools are activated. Tau does not compact automatically.

Pi's built-in `tool_search` extension must be enabled. After changing this extension during development, run `/reload` before testing.
