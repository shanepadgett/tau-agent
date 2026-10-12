export type Dataset = "linux" | "opencode"
export type Engine = "fff" | "fuzzysort" | "fzf"
export type RankingCase = { query: string; target: string; kind: "path" | "typo" }

export const cases: Record<Dataset, RankingCase[]> = {
	linux: [
		{ query: "tcp.c", target: "net/ipv4/tcp.c", kind: "path" },
		{ query: "netsocket", target: "net/socket.c", kind: "path" },
		{ query: "schedcore", target: "kernel/sched/core.c", kind: "path" },
		{ query: "ext4inode", target: "fs/ext4/inode.c", kind: "path" },
		{ query: "nvmehostcore", target: "drivers/nvme/host/core.c", kind: "path" },
		{ query: "btrfstransaction", target: "fs/btrfs/transaction.c", kind: "path" },
		{ query: "wrkqueue", target: "kernel/workqueue.c", kind: "path" },
		{ query: "kernel/workqueue.c", target: "kernel/workqueue.c", kind: "path" },
		{ query: "workquue.c", target: "kernel/workqueue.c", kind: "typo" },
		{ query: "nvme/hsot/core.c", target: "drivers/nvme/host/core.c", kind: "typo" },
	],
	opencode: [
		{ query: "schemasession", target: "packages/schema/src/session.ts", kind: "path" },
		{ query: "aiprovidersindex", target: "packages/ai/src/providers/index.ts", kind: "path" },
		{ query: "serverhandlerssession", target: "packages/server/src/handlers/session.ts", kind: "path" },
		{ query: "clirunindex", target: "packages/cli/src/run/index.ts", kind: "path" },
		{ query: "codemodeopenapiindex", target: "packages/codemode/src/openapi/index.ts", kind: "path" },
		{ query: "authredirecttest", target: "packages/console/function/src/auth-redirect.test.ts", kind: "path" },
		{ query: "protocolgroupsconfig", target: "packages/protocol/src/groups/config.ts", kind: "path" },
		{ query: "packages/schema/src/config.ts", target: "packages/schema/src/config.ts", kind: "path" },
		{ query: "schemaocnfig", target: "packages/schema/src/config.ts", kind: "typo" },
		{ query: "aiprovidresindex", target: "packages/ai/src/providers/index.ts", kind: "typo" },
	],
}
