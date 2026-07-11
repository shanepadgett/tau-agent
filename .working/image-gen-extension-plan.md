# Tau OpenAI Codex Image Generation Extension

## Status

Implemented. Awaiting manual `/reload` and an explicitly approved paid live smoke test.

This document is the handoff artifact for implementing a Tau extension that generates and edits images through the existing Pi `openai-codex` OAuth credential. It is intentionally self-contained so implementation can continue after context compaction without rereading the Codex reference repository.

## Goal

Add one Tau tool named `image_gen` that:

- Uses the OAuth credential created by Pi's `/login` flow for the `openai-codex` provider.
- Generates new images with `gpt-image-2`.
- Edits one to five local raster images with `gpt-image-2`.
- Saves every successful result as a PNG under the current workspace.
- Returns the saved path and, when small enough for Pi context, the generated image inline.
- Keeps all private Codex HTTP protocol details isolated in one extension-local client.

## Approved scope

### Public tool

Register one flat Pi tool:

```text
image_gen
```

Tool arguments:

```ts
interface ImageGenParams {
  prompt: string;
  referenced_image_paths?: string[];
}
```

Operation selection:

- Omit `referenced_image_paths` to generate a new image.
- Provide one to five `referenced_image_paths` to edit or compose from existing local images.

### Fixed behavior

- Model: `gpt-image-2`
- Background: `auto`
- Quality: `auto`
- Size: `auto`
- One output image per call
- Output format: PNG
- Output directory: `<cwd>/.working/generated-images/`
- Authentication provider: `openai-codex`

### Excluded behavior

Do not add any of the following during this implementation:

- Settings or `settings.ts`
- Model selection
- Quality or size arguments
- Background or transparency arguments
- Native transparent output through `gpt-image-1.5`
- Masks
- Batch generation
- Multiple generated outputs from one call
- Recent conversation-image selection
- Arbitrary destination paths
- Public OpenAI API-key fallback
- OpenRouter image generation
- New commands, shortcuts, panels, widgets, or configuration UI
- Changes to Pi's image-model abstraction
- Retry controls

These are separate future features and require separate approval.

## Cleanroom boundary

The implementation must follow the behavior described in this document. Do not translate Rust types, functions, comments, or tests from Codex. Do not copy Codex's bundled Python CLI.

Observed behavior used to write this specification:

- Codex exposes standalone generation as an extension tool.
- The active model is `gpt-image-2`.
- The extension chooses generation or editing based on whether image references exist.
- The backend returns base64 image data in `data[].b64_json`.
- The generated image is fed back to the model and may also be persisted locally.

The Tau implementation should use normal TypeScript, Pi extension APIs, Node APIs, and independently written tests.

## Codex HTTP protocol

The Codex route is private and undocumented. Keep every route, header, request type, and response type in `src/extensions/image-gen/client.ts` so protocol repair stays local if OpenAI changes it.

### Base URL

```text
https://chatgpt.com/backend-api/codex
```

### Generation endpoint

```http
POST https://chatgpt.com/backend-api/codex/images/generations
```

Request body:

```json
{
  "prompt": "paint a blue whale",
  "model": "gpt-image-2",
  "background": "auto",
  "quality": "auto",
  "size": "auto"
}
```

### Editing endpoint

```http
POST https://chatgpt.com/backend-api/codex/images/edits
```

Request body:

```json
{
  "images": [
    {
      "image_url": "data:image/png;base64,..."
    }
  ],
  "prompt": "add a red hat",
  "model": "gpt-image-2",
  "background": "auto",
  "quality": "auto",
  "size": "auto"
}
```

Use JSON for both routes. The Codex backend accepts image data URLs in the edit request. Do not use the public OpenAI multipart edit format against this route.

### Request headers

Send:

```http
Authorization: Bearer <OAuth access token>
chatgpt-account-id: <account ID decoded from OAuth JWT>
originator: pi
Accept: application/json
Content-Type: application/json
```

Do not send the OAuth token anywhere else. Never include it in tool output, details, logs, error messages, test snapshots, or persisted files.

### Response shape

Only depend on this minimum shape:

```ts
interface CodexImageResponse {
  data: Array<{
    b64_json: string;
  }>;
}
```

Select the first item. Fail when:

- The response is not JSON.
- `data` is absent or is not an array.
- `data` is empty.
- The first item is not an object.
- `b64_json` is absent or empty.
- Base64 decoding fails.
- Decoded bytes are not a PNG.

Ignore unrelated response metadata.

## Authentication design

Resolve authentication during each tool execution:

```ts
const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
```

This is required instead of reading `~/.pi/agent/auth.json` directly. Pi owns credential persistence, locking, and OAuth refresh.

If no token is returned, throw:

```text
OpenAI Codex OAuth is unavailable. Run /login and select OpenAI Codex.
```

### Account ID extraction

The access token is a JWT. Decode its payload with Node's base64url support:

```ts
const segments = token.split(".");
const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
```

Validation:

- Require exactly three JWT segments.
- Require the payload segment to be non-empty.
- Catch base64url and JSON decoding errors.
- Require the decoded payload to be an object.
- Require `payload["https://api.openai.com/auth"]` to be an object.
- Require `chatgpt_account_id` to be a non-empty string.

Use one generic failure message so token contents never leak:

```text
The OpenAI Codex credential does not contain a usable ChatGPT account ID. Run /login again.
```

Do not verify the JWT signature. Pi obtained and refreshes the token; the extension only needs its account claim for the required request header.

## Extension structure

Create:

```text
src/extensions/image-gen/
  index.ts
  client.ts
  README.md

test/extensions/image-gen/
  client.test.ts
  index.test.ts
```

Responsibilities:

### `src/extensions/image-gen/client.ts`

- Codex endpoint constants
- Request and response types
- OAuth JWT account-ID extraction
- Generation request
- Edit request
- HTTP error parsing and redaction
- Response validation
- Base64 decoding
- PNG validation

Keep this module independent of Pi tool registration. Accept the token, prompt, optional images, and `AbortSignal` as inputs.

Suggested internal types:

```ts
interface CodexAuth {
  token: string;
  accountId: string;
}

interface EditImage {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
}

interface GeneratedImage {
  bytes: Buffer;
  base64: string;
  mimeType: "image/png";
}
```

Suggested exported functions:

```ts
export function resolveCodexAuth(token: string): CodexAuth;

export async function generateImage(
  prompt: string,
  auth: CodexAuth,
  signal: AbortSignal | undefined,
): Promise<GeneratedImage>;

export async function editImage(
  prompt: string,
  images: readonly EditImage[],
  auth: CodexAuth,
  signal: AbortSignal | undefined,
): Promise<GeneratedImage>;
```

If testability requires replacing `fetch`, use a small internal request function or module-level `fetch`. Prefer `vi.stubGlobal("fetch", ...)` over adding a public dependency-injection API used only by tests.

### `src/extensions/image-gen/index.ts`

- Strict TypeBox tool schema
- Tool metadata and model instructions
- OAuth resolution through `ctx.modelRegistry`
- Local path normalization and image loading
- Input image signature detection
- Operation selection
- Progress update
- Safe output persistence
- Pi tool result construction

### `src/extensions/image-gen/README.md`

Product-level documentation only:

- What the extension does
- Why it exists
- How the model invokes it
- `/login` requirement
- Output location
- Private-endpoint stability warning

Do not document internal helper structure or copy Codex instructions.

## Tool schema and metadata

Use `defineTool` and TypeBox.

Schema:

```ts
const imageGenSchema = Type.Object(
  {
    prompt: Type.String({ minLength: 1 }),
    referenced_image_paths: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 5,
      }),
    ),
  },
  { additionalProperties: false },
);
```

Reject a prompt that contains only whitespace inside `execute`, since JSON Schema `minLength` does not catch it.

Recommended metadata:

```ts
{
  name: "image_gen",
  label: "Image Generation",
  description:
    "Generate a new raster image from a prompt, or edit one to five local raster images. Uses the existing OpenAI Codex OAuth login, saves a PNG under .working/generated-images, and returns the image for inspection.",
  promptSnippet: "Generate or edit raster images with OpenAI Codex",
  promptGuidelines: [
    "Use image_gen when the user asks for a generated raster image or an AI edit of local raster images.",
    "Omit referenced_image_paths when image_gen should create a new image.",
    "Pass one to five local paths in referenced_image_paths when image_gen should edit or compose existing images.",
  ],
}
```

Do not add a custom renderer in the first implementation. Pi's fallback renderer can show the compact text result. The image content uses Pi's normal image rendering.

## Local input image handling

For each `referenced_image_paths` entry, perform these steps in order:

1. Remove one leading `@`, matching Pi path conventions.
2. Reject the path if the remaining string is blank.
3. Resolve relative paths against `ctx.cwd`; preserve absolute paths.
4. Read the file with `node:fs/promises`.
5. Reject files larger than 50 MiB before converting to base64.
6. Detect MIME type from byte signatures.
7. Reject unsupported content.
8. Convert bytes to a data URL in the client request.

Supported input formats for the initial implementation:

- PNG: standard eight-byte PNG signature
- JPEG: starts with `FF D8 FF`
- WebP: `RIFF` plus `WEBP` at bytes 8 through 11

Do not trust filename extensions. Do not accept SVG because the edit endpoint expects raster input and SVG can contain active external references.

Use absolute paths only in errors after resolution so the model can repair a bad call. Do not persist the input bytes or duplicate them on disk.

## HTTP behavior and failure policy

### Cancellation

Pass the tool `signal` directly to `fetch`. When aborted, throw a concise cancellation error. Do not convert cancellation into a retry.

### Retries

Do not automatically retry generation or editing POST requests.

An interrupted request may have reached the server and incurred a charge even when the client did not receive the response. Automatic retry could create and bill another image. A later explicit tool call is the safe retry boundary.

### Error response handling

For a non-2xx response:

1. Read a bounded amount of response text.
2. If it is JSON, prefer a short message from common `error.message` or `message` fields.
3. Otherwise use a trimmed text body.
4. Limit the reported server message to 2,000 characters.
5. Replace any occurrence of the exact OAuth token with `[redacted]`.
6. Throw an error containing the operation and HTTP status.

Example:

```text
Image generation failed with status 403: Workspace is not authorized in this region.
```

Do not include full response headers. They can contain request identifiers or infrastructure details that do not help the model repair the call.

## Output persistence

### Directory

Resolve:

```text
<ctx.cwd>/.working/generated-images
```

Create it recursively when needed.

### Filename

Use an extension-generated UUID rather than raw `toolCallId`:

```text
image-<randomUUID()>.png
```

This avoids path injection, awkward provider call IDs, and accidental replacement when a session is replayed.

### Safe publication sequence

The extension must never silently overwrite an existing image.

Use `withFileMutationQueue(finalPath, ...)`. Inside the queue, perform this exact sequence:

1. Create the output directory recursively.
2. Create a randomized sibling temporary path.
3. Write the complete PNG bytes to the temporary file with exclusive creation (`flag: "wx"`).
4. Validate the temporary bytes or already validated in-memory bytes as PNG.
5. Atomically publish without overwrite by linking the temporary file to the final path with `link()`.
6. Remove the temporary path.
7. In `finally`, remove the temporary path with `force: true` so failures leave no scratch file.

Because the temporary and final paths share a directory, the hard-link publication stays on one filesystem. `link()` fails if the destination already exists and therefore cannot replace an existing asset. If hard-link publication proves unsupported on a target platform, stop and revise the design rather than adding a silent overwrite fallback.

Do not delete a successfully published final image if later inline-result construction fails. At that point the generation succeeded and the user should retain the artifact.

## Pi result shape

Successful inline result:

```ts
{
  content: [
    {
      type: "text",
      text: `Generated image saved to ${absolutePath}`,
    },
    {
      type: "image",
      data: generated.base64,
      mimeType: "image/png",
    },
  ],
  details: {
    path: absolutePath,
    model: "gpt-image-2",
    operation: "generate",
  },
}
```

For editing, use:

```ts
operation: "edit"
```

The text should say `Edited image saved to ...` for edit calls.

### Inline attachment limit

Use the same 12 MiB ceiling already used by Tau's `appshot` extension.

- Always save a valid generated PNG.
- If the PNG is at most 12 MiB, include the Pi image content.
- If the PNG exceeds 12 MiB, omit image content and return text explaining that the image was saved but was too large to attach to model context.

Oversized success result:

```ts
{
  content: [
    {
      type: "text",
      text: `Generated image saved to ${absolutePath}. The PNG exceeds the 12 MiB attachment limit, so it was not added to model context.`,
    },
  ],
  details: {
    path: absolutePath,
    model: "gpt-image-2",
    operation: "generate",
  },
}
```

Keep `details` small. Never put base64 image data, prompts, OAuth data, input image data, or raw server responses in `details`.

## Progress reporting

After local validation and before the HTTP request, emit one progress update:

- Generation: `Generating image with gpt-image-2...`
- Edit: `Editing image with gpt-image-2...`

Do not stream fake percentages. The endpoint provides no reliable progress signal.

## Implementation order

Keep each slice wired and committable.

### Slice 1: Client and client tests

1. Add `client.ts` with constants and internal types.
2. Implement JWT account-ID extraction.
3. Implement shared POST behavior without retries.
4. Implement generation and edit request construction.
5. Implement bounded/redacted errors.
6. Implement response/base64/PNG validation.
7. Add focused client tests.

No dead exports. Export only functions needed by `index.ts` or direct tests.

### Slice 2: Tool registration and input loading

1. Add strict schema and `image_gen` registration.
2. Resolve `openai-codex` auth through `ctx.modelRegistry`.
3. Normalize and load referenced paths.
4. Detect PNG, JPEG, and WebP signatures.
5. Select generate or edit.
6. Return progress updates.

### Slice 3: Safe persistence and Pi image output

1. Add output directory and UUID naming.
2. Add mutation queue and exclusive temporary write.
3. Publish with `link()` and clean temporary files.
4. Return path, details, and bounded inline image content.
5. Add tool integration tests.

### Slice 4: Product README and smoke test

1. Add the required extension README.
2. Reload Tau.
3. Run one real generation.
4. Run one real local-image edit.
5. Verify cancellation and artifact cleanup.

## Test plan

Use Vitest. No live network calls in automated tests. Use synthetic JWTs and tiny image fixtures generated in test code.

### `client.test.ts`

#### Authentication tests

- Extracts a valid `chatgpt_account_id` from a synthetic JWT.
- Rejects tokens with fewer or more than three segments.
- Rejects an invalid base64url payload.
- Rejects invalid JSON.
- Rejects a non-object payload.
- Rejects a missing auth claim.
- Rejects a missing account ID.
- Rejects an empty account ID.
- Uses one generic credential error without embedding the token or decoded payload.

#### Generation request tests

- Uses `POST`.
- Uses `/images/generations`.
- Sends exact fixed model, background, quality, and size fields.
- Sends the prompt unchanged after tool-level whitespace validation.
- Sends required auth and content headers.
- Passes the supplied `AbortSignal` to `fetch`.
- Does not issue a second request after 429 or 500.

#### Edit request tests

- Uses `/images/edits`.
- Sends `images` as objects containing data URLs.
- Preserves input image order.
- Sends the same fixed model controls as generation.
- Passes the supplied `AbortSignal`.

#### Response tests

- Returns the first `b64_json` image.
- Ignores later images.
- Rejects non-JSON success bodies.
- Rejects missing `data`.
- Rejects non-array `data`.
- Rejects empty `data`.
- Rejects missing or blank `b64_json`.
- Rejects malformed base64.
- Rejects decoded non-PNG bytes.
- Reports bounded plain-text errors.
- Extracts common JSON error messages.
- Redacts the exact OAuth token if a server body echoes it.
- Does not expose response headers.

### `index.test.ts`

Create a minimal fake `ExtensionAPI` that captures the registered tool. Mock `fetch` or mock the client module according to existing project test conventions.

#### Registration tests

- Registers exactly one tool named `image_gen`.
- Uses a strict schema.
- Requires a non-empty prompt.
- Limits referenced paths to five.
- Exposes the intended prompt metadata.

#### Authentication tests

- Missing provider credential throws the `/login` guidance.
- Invalid OAuth JWT throws the generic relogin guidance.
- Auth is resolved during execution rather than extension startup.

#### Input tests

- Whitespace-only prompt fails before network access.
- No referenced paths selects generation.
- One referenced path selects edit.
- Five referenced paths select edit and preserve order.
- Relative paths resolve against `ctx.cwd`.
- Absolute paths remain absolute.
- One leading `@` is removed.
- Blank normalized paths fail.
- Missing files fail before network access.
- Files over 50 MiB fail before base64 conversion.
- PNG signature maps to `image/png`.
- JPEG signature maps to `image/jpeg`.
- WebP signature maps to `image/webp`.
- SVG and unknown bytes fail.
- Filename extension does not override detected MIME type.

#### Persistence tests

- Creates `.working/generated-images`.
- Writes a valid PNG to a UUID filename.
- Returns an absolute saved path.
- Uses generate details for generation.
- Uses edit details for editing.
- Includes inline image content at or below 12 MiB.
- Omits inline image content above 12 MiB while retaining the saved file.
- Leaves no temporary file after success.
- Leaves no temporary file after publication failure.
- Does not replace an existing destination.
- Abort or HTTP failure creates no final output.

Avoid asserting a particular UUID. Match the filename pattern and inspect the returned path.

## Manual smoke test

Extension tool changes require `/reload` before testing.

Use the following sequence after automated implementation checks pass:

1. Run `/login` and ensure OpenAI Codex is configured if it is not already.
2. Run `/reload`.
3. Ask Tau to generate a simple image with no references.
4. Confirm one PNG appears under `.working/generated-images/`.
5. Confirm the PNG has the expected signature and non-zero size.
6. Confirm the tool result renders the image inline.
7. Use the generated PNG as `referenced_image_paths` in a second call with one specific edit.
8. Confirm a second PNG is created and the first PNG is unchanged.
9. Start another generation and cancel it.
10. Confirm cancellation leaves no partial final file or temporary file.

Do not print, inspect, copy, or save the real OAuth token during smoke testing.

## Acceptance criteria

Implementation is complete when all statements below are true:

- `image_gen` is available as a Tau extension tool after `/reload`.
- It uses Pi's existing `openai-codex` OAuth credential and automatic refresh path.
- A user does not need `OPENAI_API_KEY`.
- New image calls use `gpt-image-2` through the Codex generation endpoint.
- Calls with one to five local references use the Codex edit endpoint.
- Request headers include bearer auth, ChatGPT account ID, and `originator: pi`.
- The OAuth token cannot appear in tool output, details, errors, or files.
- Successful calls save a valid PNG under `.working/generated-images/`.
- Existing files are never silently replaced.
- PNGs at or below 12 MiB are returned to Pi as image content.
- Larger PNGs remain saved and are omitted from context with a clear explanation.
- Cancellation and failures leave no partial output or temporary files.
- POST requests are not automatically retried.
- Automated tests cover request shape, auth extraction, failures, input detection, persistence, and result shape.
- The extension README describes the user-facing behavior and private-endpoint risk.
- No settings, extra controls, fallback providers, or unrelated public behavior are added.

## Known risk

`https://chatgpt.com/backend-api/codex/images/*` is a private Codex backend contract. OpenAI may change its route, headers, payload, model availability, or subscription policy without notice.

The mitigation is structural:

- Keep protocol code in `client.ts`.
- Keep tool and filesystem behavior independent from HTTP details.
- Fail clearly on changed response shapes.
- Do not silently fall back to a paid API-key route or a different model.
- Repair the isolated client when the observed contract changes.

## Post-implementation cleanup

This plan is persisted at `.working/image-gen-extension-plan.md`. After implementation, ask whether to delete it.
