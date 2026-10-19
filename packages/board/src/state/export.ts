// 导出对话框（线框 08）的界面状态
import { createSignal } from "solid-js";
import type { ExportFormat, ExportScope } from "@codeboard/core";
import { onBoardSwitch } from "./root";

export type ExportOpts = { format: ExportFormat; scope: ExportScope["kind"]; sections: string[]; questions: boolean; boardOnly: boolean };
export const [exportOpen, setExportOpen] = createSignal<ExportOpts | null>(null);
export const [exportBusy, setExportBusy] = createSignal(false);

onBoardSwitch(() => setExportOpen(null));
