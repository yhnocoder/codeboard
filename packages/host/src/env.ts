// What the host needs from the editor beyond Workspace (core/workspace.ts). Files, settings, messages and the per-workspace state
// go through workspace(); HostEnv adds the two things only the board coordination (hub.ts) uses: state kept across all
// workspaces, and opening a view for a board. The VS Code implementation is extensions/vscode/src/panel.ts.
import type { BoardView } from "./boards";

/** Small values remembered by the editor */
export interface StateStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): Promise<void>;
}

export type ViewPlace = { preserveFocus?: boolean; side?: boolean; here?: boolean };

export interface HostEnv {
  /** State shared by every workspace (when each board was last opened, for the welcome-back hint) */
  globalState: StateStore;
  /** Opens a new view showing board `id` (a webview tab in VS Code). side = beside the current editor, here = in the current
   *  editor group; otherwise where the other boards are */
  openView(id: string, title: string, place: ViewPlace): BoardView;
}
