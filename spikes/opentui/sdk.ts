// Stand-in for the embedded `@shanepadgett/tau` SDK: a sidebar slot registry and session signals.
import { createSignal, type JSX } from "solid-js";

export type SlotRender = () => JSX.Element;

const [slots, setSlots] = createSignal<{ id: string; render: SlotRender }[]>([]);
export const sidebarSlots = slots;

export function addSidebarSlot(id: string, render: SlotRender): void {
	setSlots((list) => [...list, { id, render }]);
}

const [tokens, setTokens] = createSignal(0);
export const session = { tokens, setTokens, window: 200_000 };

export const sdkId = Symbol.for("tau.sdk.instance");
