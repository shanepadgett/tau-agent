export interface CommitMarker {
	hash: string;
	subject: string;
	timestamp: number;
}

export interface CommitEvidence {
	recentSubjects: string;
	intent: string[];
	files: readonly DirtyFile[];
}

export interface DirtyFile {
	path: string;
	status: string;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
	renamedFrom?: string;
	evidence: string;
}

export interface CommitPlanGroup {
	id: string;
	message: string;
	files: string[];
	rationale?: string;
}

export interface CommitPlanState {
	files: readonly DirtyFile[];
	groups: CommitPlanGroup[];
	worktreeSignature: string;
}

export type CommitPlanReviewAction =
	| { kind: "cancel" }
	| { kind: "execute" }
	| { kind: "editMessage"; groupId: string }
	| { kind: "assignFiles"; groupId: string }
	| { kind: "newGroup" }
	| { kind: "deleteGroup"; groupId: string }
	| { kind: "moveGroup"; groupId: string; direction: -1 | 1 }
	| { kind: "regenerateMessage"; groupId: string }
	| { kind: "regeneratePlan" };

export type CommitFilePickerResult = { kind: "cancel" } | { kind: "save"; files: string[] };
