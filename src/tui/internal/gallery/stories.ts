/** Every story the gallery lists. A new story is added here. */

import { buttonStory } from "./ButtonStory.tsx";
import { choiceRowStory } from "./ChoiceRowStory.tsx";
import { dialogStory } from "./DialogStory.tsx";
import { panelStory } from "./PanelStory.tsx";
import type { Story } from "./story.ts";

export const STORIES: readonly Story[] = [buttonStory, choiceRowStory, dialogStory, panelStory];
