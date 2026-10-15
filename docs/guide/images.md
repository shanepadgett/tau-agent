# Show images to the model

Add pictures to your prompt, and let the model look at picture files, when its model can see images.

1. Paste a picture with Ctrl+V (or Cmd+V where your terminal passes it on). The input shows `[Image 1]` at the cursor.
2. Or drop a picture file on the terminal, or paste its path. It becomes a `[Image N]` too.
3. Or type `@` and choose a picture file (PNG, JPEG, WebP, GIF or BMP).
4. Write your prompt around the chips and send it.
5. To let the model look at a file itself, ask it to; it calls `tools.image({ path })` in a `run` script and sees the picture after the script ends.

## What happens

- Tau fits each picture within 1568 pixels on its longest side, applies its EXIF rotation, and keeps it as a file in the session's output folder. The prompt holds only the `[Image N]` text.
- Delete a chip from the input to leave its picture out. The rest are numbered again when you send.
- On Linux, Tau reads the clipboard with `wl-paste` or `xclip`; install one of them.

## Limits

- A model that cannot see images gets a note in place of each picture. A line under the input warns you before you send.
- A prompt returned to the input after a cancel, and a stashed prompt, keep their `[Image N]` text but not the pictures.
- The input shows no preview of a picture.
