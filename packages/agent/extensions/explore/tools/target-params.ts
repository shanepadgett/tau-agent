import { Type } from "typebox";

/** Parameters every declaration-targeting Explore tool accepts. */
export const targetParams = {
	path: Type.String({ description: "Directory scope" }),
	targetPath: Type.Optional(Type.String({ description: "Defining file when known" })),
	name: Type.String({ minLength: 1, description: "Decl name; dotted Type.method ok" }),
	line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line pin" })),
};
