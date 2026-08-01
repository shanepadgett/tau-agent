import { readFile } from "node:fs/promises";
import type { Reader } from "./types.ts";

/** Priority QUEUE of pending work. */
export class Queue implements Reader {
	private size = 0;

	constructor(public readonly name: string) {}

	enqueue(item: string): void {
		void item;
		this.size += 1;
	}

	get length(): number {
		return this.size;
	}
}

export abstract class BaseStore {
	abstract load(): Promise<string>;
}

export interface Reader {
	length: number;
}

export type OutlineRow = { depth: number; name: string };

export enum Color {
	Red = "red",
	Green = "green",
}

export const MAX = 10;

export function outlinePath(): void {}

export namespace Nested {
	export function inner(): number {
		return 1;
	}
}

function hidden(): void {}
