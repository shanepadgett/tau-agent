# Image Generation

`image_gen` generates raster images and edits up to three local raster images with Grok Imagine. It uses `grok-imagine-image-quality` and saves results under `~/.local/share/tau-agent/images/` by default. Pass an explicit path with the expected image extension when the image should be saved in the current repository or another chosen location.

Run `/login xai` and choose either a subscription or API-key login before invoking the tool.

Run `/reload` after installing or changing the extension.

The model invokes `image_gen` with a prompt. For edits, it also supplies one to three local PNG, JPEG, or WebP paths. Successful images up to 12 MiB are returned inline for inspection; larger results remain available at the saved path.

xAI controls model availability and subscription entitlements. A successful login does not guarantee that every account can use Grok Imagine.
