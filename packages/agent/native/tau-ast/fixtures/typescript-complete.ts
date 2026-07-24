// fallow-ignore-file unused-export -- syntax fixture consumed by tau-ast Rust tests
// fallow-ignore-file unused-type -- syntax fixture consumed by tau-ast Rust tests
// oxfmt-ignore
import type {
    Input,
    Output,
} from "./types.ts";
import { unused } from "./unused.ts";

void unused;

function sealed(value: object, context: ClassDecoratorContext): void {
	void value;
	void context;
}

declare function registerService(value: object): void;

/**
 * Refresh one value.
 * @deprecated Use refreshMany.
 */
export function refresh<T extends Input = Input>(value: T): Promise<Output>;
export function refresh(value: Input): Promise<Output>;
export function refresh(value: Input): Promise<Output> {
	return Promise.resolve({ value });
}

export declare function ambient(value: Input): Output;

@sealed
export abstract class Service<T extends Input> {
	protected cache = new Map<string, T>();
	readonly value: T;

	constructor(value: T) {
		this.value = value;
	}

	abstract run(value: T): Promise<Output>;

	get ready(): boolean {
		return true;
	}

	set ready(value: boolean) {
		void value;
	}

	callback = (value: T): T => value;
}

export interface Contract<T extends Input> {
	run(value: T): Promise<Output>;
	callback: (value: T) => T;
}

// oxfmt-ignore
export type Mapper<T extends Input = Input> = (
    _value: T,
) => Promise<Output>;

export const makeService = <T extends Input>(_value: T): Service<T> => null as unknown as Service<T>;

registerService(Service);
export { makeService as createService };
