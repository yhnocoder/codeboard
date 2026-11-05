// A picture onto the OS clipboard when the board's webview could not write it (VS Code's clipboard API takes only text): the
// platform's own tool reads it from a temporary file
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/** The command that puts the PNG at file on the clipboard, per platform; several to try in turn on Linux */
function commands(file: string): [string, string[]][] {
  if (process.platform === "darwin")
    return [
      [
        "osascript",
        [
          "-e",
          "on run argv",
          "-e",
          "set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)",
          "-e",
          "end run",
          file,
        ],
      ],
    ];
  if (process.platform === "win32")
    return [
      [
        "powershell.exe",
        [
          "-NoProfile",
          "-STA",
          "-Command",
          "Add-Type -AssemblyName System.Windows.Forms, System.Drawing; " +
            "$i = [System.Drawing.Image]::FromFile($env:CODEBOARD_PNG); [System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()",
        ],
      ],
    ];
  return [
    ["wl-copy", ["--type", "image/png"]],
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-i", file]],
  ];
}

/** Runs one; true when it exited with 0. wl-copy reads stdin; xclip and wl-copy stay behind to serve the clipboard, so their
 *  output is not waited for, only the exit of the process started */
function run(cmd: string, args: string[], file: string): Promise<boolean> {
  return new Promise((ok) => {
    const stdin = cmd === "wl-copy" ? "pipe" : "ignore";
    const p = spawn(cmd, args, { stdio: [stdin, "ignore", "ignore"], env: { ...process.env, CODEBOARD_PNG: file } });
    p.on("error", () => ok(false));
    p.on("exit", (code) => ok(code === 0));
    if (p.stdin)
      void fs.readFile(file).then(
        (b) => p.stdin!.end(b),
        () => p.kill(),
      );
  });
}

export async function copyImage(png: Uint8Array): Promise<boolean> {
  // in a remote window the extension runs on the other machine: its clipboard is not the user's
  if (vscode.env.remoteName) return false;
  if (process.platform === "linux" && !process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) return false;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codeboard-clip-"));
  const file = path.join(dir, "image.png");
  try {
    await fs.writeFile(file, png);
    for (const [cmd, args] of commands(file)) {
      if (cmd === "wl-copy" && !process.env.WAYLAND_DISPLAY) continue;
      if (await run(cmd, args, file)) return true;
    }
    return false;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
