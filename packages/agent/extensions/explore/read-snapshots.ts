import { MAX_COMPLETE_FILE_SNAPSHOT_BYTES } from "./full-file-knowledge.ts";

const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

interface Snapshot {
	text: string;
	bytes: number;
}

export interface ReadSnapshotStore {
	get(hash: string): string | undefined;
	epoch(): number;
	isCurrent(epoch: number): boolean;
	set(hash: string, text: string, bytes: number, epoch: number): boolean;
	clear(): void;
}

export function createReadSnapshotStore(): ReadSnapshotStore {
	const snapshots = new Map<string, Snapshot>();
	let totalBytes = 0;
	let epoch = 0;

	return {
		get(hash) {
			const snapshot = snapshots.get(hash);
			if (!snapshot) return undefined;
			snapshots.delete(hash);
			snapshots.set(hash, snapshot);
			return snapshot.text;
		},
		epoch() {
			return epoch;
		},
		isCurrent(candidate) {
			return candidate === epoch;
		},
		set(hash, text, bytes, candidateEpoch) {
			if (candidateEpoch !== epoch || bytes > MAX_COMPLETE_FILE_SNAPSHOT_BYTES) return false;
			if (snapshots.has(hash)) return true;
			snapshots.set(hash, { text, bytes });
			totalBytes += bytes;
			while (totalBytes > MAX_TOTAL_BYTES) {
				const oldestHash = snapshots.keys().next().value as string | undefined;
				if (oldestHash === undefined) break;
				const oldest = snapshots.get(oldestHash);
				snapshots.delete(oldestHash);
				totalBytes -= oldest?.bytes ?? 0;
			}
			return true;
		},
		clear() {
			snapshots.clear();
			totalBytes = 0;
			epoch += 1;
		},
	};
}
