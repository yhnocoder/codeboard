import { createSignal } from "solid-js";
import type { ExportFormat, ExportScope } from "@codeboard/core";

export type ExportOpts = { format: ExportFormat; scope: ExportScope["kind"]; sections: string[]; questions: boolean; boardOnly: boolean };
export const [exportOpen, setExportOpen] = createSignal<ExportOpts | null>(null);
export const [exportBusy, setExportBusy] = createSignal(false);
