// Bridges dockview-native tab drags to the rail's drop targets (E12-04 fix
// from Dan's eyeball pass): a dockview tab drag carries dockview's own
// dataTransfer payload, not our x-switchboard-card type, so the rail reads
// the in-flight card from here instead.
let draggedCardId: string | null = null;

export function setDraggedCard(id: string | null): void {
  draggedCardId = id;
}

export function getDraggedCard(): string | null {
  return draggedCardId;
}
