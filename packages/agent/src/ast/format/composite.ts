export type CompositeBlock = {
	id: string;
	label: string;
	text: string;
};

/** Shared section packing for impact/context complete-block emission. */
export function compositeSectionBlocks(args: {
	header: string;
	emptyLabel: string;
	sections: readonly { id: string; label: string; text: string }[];
	footers: readonly string[];
}): CompositeBlock[] {
	const blocks: CompositeBlock[] = [{ id: "header", label: "header", text: args.header }];
	if (args.sections.length === 0) {
		blocks.push({ id: "empty", label: "empty", text: args.emptyLabel });
	} else {
		for (const section of args.sections) {
			blocks.push({ id: section.id, label: section.label, text: section.text });
		}
	}
	if (args.footers.length > 0) {
		blocks.push({ id: "footer", label: "footer", text: args.footers.join("\n") });
	}
	return blocks;
}
