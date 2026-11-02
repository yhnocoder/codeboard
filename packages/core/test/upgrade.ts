// An older board as the board UI gets it: the host upgrades the file when it reads it (loadBoardFile) and sends it with the camera,
// the UI checks it (checkBoard)
import { checkBoard, loadBoardFile, type Board } from "../src";

export const upgraded = (raw: unknown): Board =>
  checkBoard({ ...loadBoardFile(raw), cam: (raw as { cam?: unknown } | null)?.cam ?? { x: 0, y: 0, z: 1 } });
