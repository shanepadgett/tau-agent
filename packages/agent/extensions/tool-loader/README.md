# Tool Loader

Tau progressively exposes specialist tools. Most coding turns do not need web, image, or macOS application schemas, so Pi can load those tools later without discarding supported provider cache prefixes.

The agent normally calls `load_tools` itself. Users can also ask Tau to load one of these groups:

- `web` for public web and implementation research
- `image` for raster image generation and editing
- `appshot` for macOS window discovery, capture, and activation

Supported models optimize prompt caching when a group loads. Other models keep the same functional behavior.

After changing this extension during development, run `/reload` before testing.
