// The board's change and undo engine and its saving, on plain objects: any shell wires them to its own store (the board UI: its
// Solid store in packages/board/src/state/changes.ts)
export { createHistory, type Doc, type HistoryPorts } from "./history";
export { createSave } from "./save";
export { NOT_UNDONE } from "./snap";
