import * as os from "node:os";
import { formatDiagnostics, type Board, type DiagInfo } from "@codeboard/core";
import { git } from "./git";
import type { Prompts } from "./prompts";
import type { HostContext } from "./context";

async function folderInfo(p: string): Promise<DiagInfo["folders"][number]> {
  const head = (await git(p, ["rev-parse", "HEAD"]))?.trim();
  if (!head) return { path: p, git: false };
  const st = await git(p, ["status", "--porcelain", "--untracked-files=no"]);
  return { path: p, git: true, head, dirty: !!st?.trim() };
}

/** board 给了就带上规模，并问一次要不要附上白板 JSON */
export async function copyDiagnostics(cx: HostContext, ask: Prompts, board?: Board) {
  let attach = false;
  if (board) {
    const pick = await ask.pick(
      [
        { label: "Copy Diagnostics", description: "Versions, workspace, recent log", attach: false },
        { label: "Copy Diagnostics + Board JSON", description: `Also attach “${board.name}”`, attach: true },
      ],
      { title: "Copy Diagnostics", placeHolder: "Attach board JSON?" },
    );
    if (!pick) return;
    attach = pick.attach;
  }
  const w = cx.ws;
  const yes = (id: string) => (w.about.hasExtension(id) ? "yes" : "no");
  const info: DiagInfo = {
    ext: w.about.ext,
    app: `VS Code ${w.about.app}`,
    os: `${process.platform} ${os.release()} ${process.arch}`,
    env: [`Python ext: ${yes("ms-python.python")} · Pylance: ${yes("ms-python.vscode-pylance")}`],
    folders: await Promise.all(cx.roots().map(folderInfo)),
    board: board && {
      name: board.name,
      cards: board.cards.length,
      arrows: board.links.length,
      sections: board.sections.length,
    },
    log: cx.recentLog(),
    boardJson: board && attach ? JSON.stringify(board, null, 1) : undefined,
  };
  await w.ui.copy(formatDiagnostics(info, os.homedir()));
  void w.ui.info("Diagnostics copied to clipboard");
}
