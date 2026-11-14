import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes
import ImageIO

// LookCompare --stage6 <out folder> [<main's pictures>]: sub-board cards, folder boards and seals on made-up boards,
// drawn off screen at 2x in each theme light and dark. With main's pictures (tools/look/subboard.mjs), each sheet that has
// one is put beside it. <out>/<sheet>-<theme>[-dark].png

enum Stage6Sheets {
  static let size = CGSize(width: 1200, height: 720)

  static func cid(_ s: String) -> CardID { CardID(rawValue: s) }

  static func code(_ id: String, x: Double, y: Double, w: Double, h: Double, _ name: String) -> Card {
    let seg = Segment(
      id: SegmentID(rawValue: "s-\(id)"), source: .file(path: "engine/scheduler.py", hash: nil), language: "python",
      firstLine: 1, lines: ["def \(name)(self):", "    pass"], symbol: Symbol(name: name, kind: .function))
    return Card(
      id: cid(id), x: x, y: y, width: w, height: h, content: .own(CardContent(body: .code(CodeCard(segments: [seg])))))
  }

  /// The board main's Storybook shows in its sub-board card (stories/support/cards.ts subBoard), at the sizes its
  /// skeleton gives them
  static func scheduler() -> Board {
    var b = Board(
      id: BoardID(rawValue: "sb-sched"),
      cards: [
        code("s", x: 40, y: 80, w: 520, h: 520, "schedule"), code("p", x: 640, y: 80, w: 420, h: 147, "preempt"),
        code("a", x: 640, y: 420, w: 420, h: 90, "can_append"),
        Card(
          id: cid("n"), x: 40, y: 700, width: 360, height: 160,
          content: .own(CardContent(body: .note(Note(text: "## 抢占\n\nblock 不够就抢占最后进来的请求。"))))),
      ],
      sections: [
        Section(
          id: SectionID(rawValue: "sec1"), title: "Scheduler", x: 20, y: 30, width: 1080, height: 640, color: "blue"),
        Section(id: SectionID(rawValue: "sec2"), title: "Notes", x: 20, y: 680, width: 400, height: 300, color: "sand"),
      ])
    b.arrows = [
      Arrow(id: ArrowID(rawValue: "l1"), from: Endpoint(card: cid("s")), to: Endpoint(card: cid("p"))),
      Arrow(id: ArrowID(rawValue: "l2"), from: Endpoint(card: cid("s")), to: Endpoint(card: cid("a"))),
      Arrow(id: ArrowID(rawValue: "l3"), from: Endpoint(card: cid("n")), to: Endpoint(card: cid("p"))),
    ]
    return b
  }

  @MainActor static func run(out: URL, main: URL?) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    Task { @MainActor in
      do {
        try await draw(out: out, main: main)
        exit(0)
      } catch {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        exit(1)
      }
    }
    app.run()
    exit(0)
  }

  typealias Rig = SidenoteSheets.Rig

  static func load(_ url: URL) -> CGImage? {
    guard let s = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(s, 0, nil)
  }

  /// A part of the canvas (view points), at 2x
  @MainActor static func cut(_ r: Rig, _ rect: CGRect) throws -> CGImage {
    let img = try EditSheets.render(r.canvas.layer!, size: r.canvas.bounds.size, scale: 2)
    return img.cropping(to: CGRect(x: rect.minX * 2, y: rect.minY * 2, width: rect.width * 2, height: rect.height * 2))
      ?? img
  }

  @MainActor static func draw(out: URL, main: URL?) async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "look-stage6-\(ProcessInfo.processInfo.processIdentifier)")
    defer { try? fm.removeItem(at: root) }
    try fm.createDirectory(at: out, withIntermediateDirectories: true)
    let notes = NoteRenderer(cache: root.appending(path: "cache"))
    for theme in Theme.all.flatMap({ [$0, Theme.named($0.id, dark: true)] }) {
      let suffix = theme.id.rawValue + (theme.dark ? "-dark" : "")
      let vault = root.appending(path: "vault")
      // a sub-board card as main's story has it: 520 × 340, its name 46 above it
      let sheet = Board(
        id: BoardID(rawValue: "sheet"),
        cards: [
          Card(
            id: cid("sub"), x: 0, y: 0, width: 520, height: 340,
            content: .own(CardContent(body: .board(SubBoard(board: BoardID(rawValue: "sb-sched"))))))
        ])
      let r = try await Rig(
        root: vault, notes: notes, theme: theme, board: sheet, others: [("Scheduler", scheduler())], size: size,
        centre: CGPoint(x: 260, y: 170))
      await r.canvas.drawAll()
      let o = r.canvas.viewPoint(CGPoint(x: 0, y: 0))
      var cuts = [try cut(r, CGRect(x: o.x - 10, y: o.y - 60, width: 540, height: 410))]
      r.close()
      if let main, let m = load(main.appending(path: "sub-\(suffix).png")) { cuts.insert(m, at: 0) }
      EditSheets.write(try WritingSheets.row(cuts, theme: theme), out, "subboard-\(suffix)")

      // a folder board's card whose board went away outside the app: kept with the arrow on it, drawn as main draws a
      // board it cannot find, under the name it last had
      var fb = Board(
        id: BoardID(rawValue: "sb-fb"),
        cards: [
          Card(
            id: cid("why"), x: -420, y: 60, width: 300,
            content: .own(CardContent(body: .note(Note(text: "## 为什么\n\n先看这块。")))))
        ])
      fb.keepUp(with: [.board(BoardID(rawValue: "sb-sched"))])
      let auto = fb.autoCards[0].card.id
      fb.arrows = [Arrow(id: ArrowID(rawValue: "m1"), from: Endpoint(card: cid("why")), to: Endpoint(card: auto))]
      let mr = try await Rig(
        root: vault, notes: notes, theme: theme, zoom: 0.8, board: fb,
        others: [("书 Book/Scheduler", scheduler())], size: size, centre: CGPoint(x: 0, y: 260),
        sheet: "书 Book/.folder")
      await mr.canvas.drawAll()
      try FileManager.default.removeItem(at: vault.appending(path: "书 Book/Scheduler.board"))
      mr.canvas.vaultChanged()
      await mr.until { mr.canvas.isGone(auto) }
      await mr.canvas.drawAll()
      EditSheets.write(try cut(mr, CGRect(origin: .zero, size: size)), out, "missing-card-\(suffix)")
      mr.close()
    }
    var lines = [
      "subboard-<theme>.png: main's sub-board card (its Storybook story, rendered in Chromium) on the left, ours drawn"
        + " natively on the right",
      "missing-card-<theme>.png: a folder board's automatic card after its board was removed outside the app: it stays"
        + " where it was with the arrow on it, under the name it last had, as main draws a board it cannot find (its"
        + " sentence, an empty card); the folder board's file is not written for it",
    ]
    lines += try sidebars(out: out, root: root)
    lines += try await boards(out: out, root: root, notes: notes)
    try (lines.joined(separator: "\n\n") + "\n").write(
      to: out.appending(path: "report.txt"), atomically: true, encoding: .utf8)
  }
}
