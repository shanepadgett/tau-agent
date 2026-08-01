let showCheckpointRows = false;

export function setCheckpointRowsVisible(visible: boolean): void {
	showCheckpointRows = visible;
}

export function areCheckpointRowsVisible(): boolean {
	return showCheckpointRows;
}
