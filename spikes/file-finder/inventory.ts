import { lstatSync } from "node:fs"
import { join } from "node:path"

// Actual regular files, intersected with git's tracked/unignored list.
// Scanning avoids phantom case-colliding names on macOS.
export const enumerate = (root: string): string[] => {
	const git = Bun.spawnSync(["git", "-c", "core.ignoreCase=false", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"])
	if (git.exitCode !== 0) throw new Error(git.stderr.toString())
	const visible = new Set(git.stdout.toString().split("\0"))
	const ignored = Bun.spawnSync(["git", "-c", "core.ignoreCase=false", "-C", root, "check-ignore", "--no-index", "--stdin", "-z"], { stdin: git.stdout })
	if (ignored.exitCode !== 0 && ignored.exitCode !== 1) throw new Error(ignored.stderr.toString())
	const excluded = new Set(ignored.stdout.toString().split("\0"))
	return [...new Bun.Glob("**/*").scanSync({ cwd: root, dot: true, onlyFiles: true, followSymlinks: false })]
		.filter((path) => visible.has(path) && !excluded.has(path) && lstatSync(join(root, path)).isFile())
		.sort()
}
