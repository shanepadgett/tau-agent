export type PathTreeEntryType = "file" | "dir";

export interface PathTreeEntry {
	displayPath: string;
	type: PathTreeEntryType;
	metadata?: string;
	empty?: boolean;
}

export interface PathTreeRenderOptions {
	rootPath?: string;
	omissionNotice?: string;
}

export interface PathTreeRender {
	humanText: string;
	agentText: string;
}

interface TreeNode {
	name: string;
	type: PathTreeEntryType;
	metadata?: string;
	empty?: boolean;
	children: Map<string, TreeNode>;
}

function splitDisplayPath(displayPath: string): string[] {
	if (displayPath === ".") return [];
	if (displayPath === "/") return ["/"];
	if (displayPath.startsWith("/")) return ["/", ...displayPath.slice(1).split("/").filter(Boolean)];
	return displayPath.split("/").filter(Boolean);
}

function isUnderRoot(rootPath: string, displayPath: string): boolean {
	if (rootPath === "/") return displayPath.startsWith("/");
	if (rootPath === ".") return !displayPath.startsWith("/");
	return displayPath === rootPath || displayPath.startsWith(`${rootPath}/`);
}

function relativeToRoot(rootPath: string, displayPath: string): string {
	if (rootPath === "/") return displayPath === "/" ? "" : displayPath.slice(1);
	if (rootPath === ".") return displayPath === "." ? "" : displayPath;
	if (displayPath === rootPath) return "";
	return displayPath.slice(rootPath.length + 1);
}

function entryLabel(node: TreeNode): string {
	const name = node.name === "/" ? "/" : node.type === "dir" ? `${node.name}/` : node.name;
	return node.metadata ? `${name} ${node.metadata}` : name;
}

function sortChildren(node: TreeNode): TreeNode[] {
	return [...node.children.values()].sort((a, b) => {
		if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

function createNode(name: string, type: PathTreeEntryType): TreeNode {
	return { name, type, children: new Map() };
}

function insert(root: TreeNode, relativePath: string, entry: PathTreeEntry): void {
	const parts = splitDisplayPath(relativePath);
	if (parts.length === 0) {
		root.type = entry.type;
		root.metadata = entry.metadata;
		root.empty = entry.empty;
		return;
	}

	let current = root;
	for (let i = 0; i < parts.length; i += 1) {
		const part = parts[i];
		if (!part) continue;
		const isLeaf = i === parts.length - 1;
		const type = isLeaf ? entry.type : "dir";
		let child = current.children.get(part);
		if (!child) {
			child = createNode(part, type);
			current.children.set(part, child);
		}
		if (isLeaf) {
			child.type = entry.type;
			child.metadata = entry.metadata;
			child.empty = entry.empty;
		}
		current = child;
	}
}

function renderHumanNode(node: TreeNode, depth: number, lines: string[]): void {
	lines.push(`${"  ".repeat(depth)}${entryLabel(node)}`);
	if (node.empty && node.children.size === 0) lines.push(`${"  ".repeat(depth + 1)}[empty]`);
	for (const child of sortChildren(node)) renderHumanNode(child, depth + 1, lines);
}

function renderAgentNode(node: TreeNode, depth: number, lines: string[]): void {
	if (node.type === "file") {
		lines.push(`${"  ".repeat(depth)}${entryLabel(node)}`);
		return;
	}

	const children = sortChildren(node);
	const files = children.filter((child) => child.type === "file").map(entryLabel);
	let line = `${"  ".repeat(depth)}${entryLabel(node)}`;
	if (files.length > 0) line += `: ${files.join(", ")}`;
	else if (node.empty && children.length === 0) line += " [empty]";
	lines.push(line);

	for (const child of children) {
		if (child.type === "dir") renderAgentNode(child, depth + 1, lines);
	}
}

function buildTree(entries: readonly PathTreeEntry[], rootPath: string | undefined): TreeNode {
	const rootName = rootPath === undefined ? "" : rootPath === "." ? "." : rootPath;
	const root = createNode(rootName, "dir");
	for (const entry of entries) {
		if (rootPath !== undefined && isUnderRoot(rootPath, entry.displayPath)) {
			insert(root, relativeToRoot(rootPath, entry.displayPath), entry);
		} else {
			insert(root, entry.displayPath, entry);
		}
	}
	return root;
}

function appendNotice(lines: string[], notice: string | undefined): void {
	if (notice) lines.push(notice);
}

export function renderPathTree(entries: readonly PathTreeEntry[], options: PathTreeRenderOptions = {}): PathTreeRender {
	const root = buildTree(entries, options.rootPath);
	const humanLines: string[] = [];
	const agentLines: string[] = [];

	if (options.rootPath === undefined) {
		for (const child of sortChildren(root)) renderHumanNode(child, 0, humanLines);
		for (const child of sortChildren(root)) renderAgentNode(child, 0, agentLines);
	} else {
		renderHumanNode(root, 0, humanLines);
		renderAgentNode(root, 0, agentLines);
	}

	appendNotice(humanLines, options.omissionNotice);
	appendNotice(agentLines, options.omissionNotice);
	return { humanText: humanLines.join("\n"), agentText: agentLines.join("\n") };
}
