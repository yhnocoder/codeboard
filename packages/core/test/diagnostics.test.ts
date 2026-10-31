import { describe, expect, it } from "vitest";
import { formatDiagnostics, recentErrors, tildify } from "../src";

describe("diagnostics", () => {
  it("tildify replaces the home folder only at path boundaries", () => {
    expect(tildify("/home/ann/code/x.py and /home/ann", "/home/ann")).toBe("~/code/x.py and ~");
    expect(tildify("/home/anna/x", "/home/ann")).toBe("/home/anna/x");
    expect(tildify('path=/Users/bo/a resolved="/Users/bo/b"', "/Users/bo/")).toBe('path=~/a resolved="~/b"');
    expect(tildify("C:\\Users\\bo\\repo and C:/Users/bo/x", "C:\\Users\\bo")).toBe("~\\repo and ~/x");
    expect(tildify("/x", "")).toBe("/x");
  });

  it("recentErrors keeps warn / error lines with their time", () => {
    const log = [
      "2026-10-16T03:30:00.000Z [info] opened",
      "2026-10-16T03:33:10.000Z [warn] vars f → callSite miss",
      "2026-10-16T03:35:02.000Z [error] storage: bad file",
    ];
    expect(recentErrors(log)).toEqual(["  03:33:10 vars f → callSite miss", "  03:35:02 error: storage: bad file"]);
  });

  it("formats the report and hides the home folder", () => {
    const t = formatDiagnostics(
      {
        ext: "0.1.5",
        app: "VS Code 1.105.0",
        os: "darwin 24.1.0 arm64",
        env: ["Python ext: yes · Pylance: no"],
        folders: [
          { path: "/Users/bo/code/nano-vllm", git: true, head: "bb823b3c0ffee", dirty: false },
          { path: "/tmp/x", git: false },
        ],
        board: { name: "flow", cards: 14, arrows: 11, sections: 2 },
        log: ["2026-10-16T03:35:00.000Z [warn] expand __init__ → No definition path=/Users/bo/code/a.py"],
        boardJson: '{"id":"b1"}',
      },
      "/Users/bo",
    );
    expect(t).toContain("CodeBoard 0.1.5 · VS Code 1.105.0 · darwin 24.1.0 arm64");
    expect(t).toContain("Python ext: yes · Pylance: no");
    expect(t).toContain("Workspace: ~/code/nano-vllm @ bb823b3 (clean)");
    expect(t).toContain("Workspace: /tmp/x (not a git repo)");
    expect(t).toContain("Board: “flow” · 14 cards · 11 arrows · 2 sections");
    expect(t).toContain("  03:35:00 expand __init__ → No definition path=~/code/a.py");
    expect(t).toContain('Board JSON:\n{"id":"b1"}');
    expect(t).not.toContain("/Users/bo");
  });
});
