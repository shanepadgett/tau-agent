import { readFile } from "node:fs/promises";

interface Parser {
	parse(source: string): Promise<Result>;
}

type Result = {
	ok: boolean;
};

class FileParser implements Parser {
	private source = "";

	async parse(source: string): Promise<Result> {
		this.source = await readFile(source, "utf8");
		return { ok: this.source.length > 0 };
	}
}

const createParser = () => new FileParser();
void createParser;
