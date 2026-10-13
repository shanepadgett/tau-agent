/**
 * The ID of one conversation with a model. Some providers use it to route requests and to cache
 * prompts.
 */

import { Schema } from "effect";

export const ConversationId = Schema.String.pipe(Schema.brand("ConversationId"));
export type ConversationId = typeof ConversationId.Type;
