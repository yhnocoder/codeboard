// The storage on its own, for a shell that has board files but no editor (the macOS app): Storage on an Fs the shell implements
export { Storage } from "./boards";
export { dropMadeBoard, restoreMadeBoard, storeNewBoard } from "./subboards";
export type { Fs } from "./fs";
export { FAINT_BELOW, MIN_SCORE, projectDocs, REINDEX_PAUSE, TOP, type Origin } from "../meaningdocs";
