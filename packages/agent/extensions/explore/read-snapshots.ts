const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

interface Snapshot {
	text: string;
	bytes: number;
}

export interface ReadSnapshotStore {
	get(hash: string): string | undefined;
	set(hash: string, text: string, bytes: number): void;
	clear(): void;
}

export function createReadSnapshotStore(): ReadSnapshotStore {
	const snapshots = new Map<string, Snapshot>();
	let totalBytes = 0;

	return {
		get(hash) {
			const snapshot = snapshots.get(hash);
			if (!snapshot) return undefined;
			snapshots.delete(hash);
			snapshots.set(hash, snapshot);
			return snapshot.text;
		},
		set(hash, text, bytes) {
			if (bytes > MAX_SNAPSHOT_BYTES || snapshots.has(hash)) return;
			snapshots.set(hash, { text, bytes });
			totalBytes += bytes;
			while (totalBytes > MAX_TOTAL_BYTES) {
				const oldestHash = snapshots.keys().next().value as string | undefined;
				if (oldestHash === undefined) break;
				const oldest = snapshots.get(oldestHash);
				snapshots.delete(oldestHash);
				totalBytes -= oldest?.bytes ?? 0;
			}
		},
		clear() {
			snapshots.clear();
			totalBytes = 0;
		},
	};
}
