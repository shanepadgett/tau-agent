import { Type } from "typebox";

export function stringEnum<T extends readonly string[]>(values: T, options: { description: string }) {
	return Type.Unsafe<T[number]>({ type: "string", enum: values, description: options.description });
}
