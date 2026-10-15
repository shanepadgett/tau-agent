/**
 * Opens the design gallery in the terminal, where the new front end is shown and approved before
 * it reaches the app. Run it with `mise run gallery`.
 */

import { createCliRenderer } from "@opentui/core";
import { showGallery } from "./internal/gallery/Shell.tsx";

const renderer = await createCliRenderer({ exitOnCtrlC: false });
await showGallery(renderer);
