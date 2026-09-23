# Tool Loader

Tau progressively exposes registered specialist tool groups. Most coding turns do not need web, image, macOS application, or application-specific schemas, so Pi can load those tools later without discarding supported provider cache prefixes.

The agent normally calls `load_tools` itself. Tau's built-in groups are:

- `web` for public web and implementation research
- `image` for raster image generation and editing
- `appshot` for macOS window discovery, capture, and activation

Project and global package extensions can add groups with `registerDeferredToolGroup()` from `@shanepadgett/tau-agent`. The group description is included in the loader catalog so the agent can select it when a task needs that capability.

Supported models load new groups without replacing the cached prompt prefix. If the selected model cannot do that, the group is queued for activation after successful compaction. The loader reports this and does not compact automatically.

After changing this extension during development, run `/reload` before testing.
