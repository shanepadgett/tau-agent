import { Type } from "typebox";

/** Parameters every declaration-targeting Explore tool accepts. */
export const targetParams = {
	path: Type.String({ description: "Directory scope (repo/package/subtree)" }),
	targetPath: Type.Optional(Type.String({ description: "Defining file when known" })),
	name: Type.String({ minLength: 1, description: "Declaration name; may be dotted (Type.method)" }),
	line: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line to pin one candidate" })),
};
