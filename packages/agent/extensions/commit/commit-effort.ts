import type { ModelEffort } from "../../shared/model-effort.ts";
import type { DirtyFile } from "./git-change-set.ts";

const LOW_EFFORT_MAX_CHANGED_LINES = 500;

export function commitEffort(files: readonly Pick<DirtyFile, "changeSize">[]): ModelEffort {
	let changedLines = 0;
	for (const file of files) {
		if (file.changeSize === "binary") return "standard";
		changedLines += file.changeSize;
		if (changedLines > LOW_EFFORT_MAX_CHANGED_LINES) return "standard";
	}
	return "quick";
}
