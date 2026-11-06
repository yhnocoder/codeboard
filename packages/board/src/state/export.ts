import { createSignal } from "solid-js";
import type { ExportFormat, ExportScope } from "@codeboard/core";

export type ExportOpts = {
  format: ExportFormat;
  scope: ExportScope["kind"];
  sections: string[];
  questions: boolean;
  boardOnly: boolean;
};
export const [exportOpen, setExportOpen] = createSignal<ExportOpts | null>(null);
export const [exportBusy, setExportBusy] = createSignal(false);
/** Sidenotes an export leaves out (board-only ones): while it clones the board, code cards draw their Highlights without them, so
 *  the copy is laid out as if they were not there (actions/export.ts) */
export const [exportHidden, setExportHidden] = createSignal<ReadonlySet<string>>(new Set());
