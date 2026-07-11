# Image Generation

`image_gen` generates raster images and edits up to five local raster images with OpenAI Codex. It uses the current `gpt-image-2` model and saves results under `~/.local/share/tau-agent/images/` by default. Pass an explicit PNG path when the image should be saved in the current repository or another chosen location.

Use `/login` and select OpenAI Codex before invoking the tool. No `OPENAI_API_KEY` is needed.

Run `/reload` after installing or changing the extension.

The model invokes `image_gen` with a prompt. Size, quality, and background use the Codex automatic settings. For edits, it also supplies one to five local PNG, JPEG, or WebP paths. Successful PNGs up to 12 MiB are returned inline for inspection; larger results remain available at the saved path.

This extension calls a private Codex backend. OpenAI may change its availability or protocol without notice.
