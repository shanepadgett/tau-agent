# Image Generation

`image_gen` generates raster images and edits up to three local raster images with OpenAI GPT Image or xAI Grok Imagine. It uses `gpt-image-2` for OpenAI and `grok-imagine-image-quality` for xAI.

By default, the tool follows the parent model: GPT models prefer OpenAI and Grok models prefer xAI. If that provider has no configured authentication, it tries the other provider. The model can pass `provider: "openai"` or `provider: "xai"` to override automatic selection.

Run `/login openai-codex` for GPT Image or `/login xai` for Grok Imagine before invoking the tool. OpenAI image generation uses the existing Codex subscription login; xAI supports its configured login methods.

Run `/reload` after installing or changing the extension.

Results are saved under `~/.local/share/tau-agent/images/` by default. Pass an explicit path with the expected image extension when the image should be saved in the current repository or another chosen location. For edits, supply one to three local PNG, JPEG, or WebP paths. Successful images up to 12 MiB are returned inline for inspection; larger results remain available at the saved path.

The OpenAI path calls a private Codex backend, which may change without notice. xAI controls Grok Imagine availability and subscription entitlements. A successful login does not guarantee image access.
