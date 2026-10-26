import type { BoardView } from "./boards";

export interface StateStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): Promise<void>;
}

export type ViewPlace = { preserveFocus?: boolean; side?: boolean; here?: boolean };

export interface HostEnv {
  globalState: StateStore;
  /** side = beside the current editor, here = in the current editor group; otherwise where the other boards are */
  openView(id: string, title: string, place: ViewPlace): BoardView;
}
