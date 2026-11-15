import AppKit
import CodeBoardCanvas
import CodeBoardModel

/// The views a card is written in: the web editor, or the native Markdown and code editors that replace it
let editorViews: Set<String> = ["EditorWebView", "MarkdownEditorView", "CodeEditorView"]

/// One walk through the app: its boards (made-up content), what the hands do, and what must hold in the recording
struct Scenario {
  var name: String
  var about: String
  var boards: [(title: String, board: Board)]
  var sidebar = false
  var sheetEvery = 1
  var checks: [([Driver.Frame]) -> Verdict] = []
  var run: @MainActor (Driver) async throws -> Void
  var folder = URL(filePath: "/")
}

private func cid(_ s: String) -> CardID { CardID(rawValue: s) }

private func note(_ id: String, _ text: String, x: Double, y: Double, w: Double = 300, section: String? = nil) -> Card {
  Card(
    id: cid(id), x: x, y: y, width: w, section: section.map(SectionID.init(rawValue:)),
    content: .own(CardContent(body: .note(Note(text: text)))))
}

/// The frames whose label starts with `p`
func labelled(_ frames: [Driver.Frame], _ p: String) -> [Driver.Frame] { frames.filter { $0.label.hasPrefix(p) } }

/// How much the picture varies inside a rect (window points from the top left): the spread of its luminance
func spread(_ f: Driver.Frame, _ r: [Double], in folder: URL) -> Double? {
  guard let name = f.image,
    let img = NSImage(contentsOf: folder.appending(path: name))?.cgImage(forProposedRect: nil, context: nil, hints: nil)
  else { return nil }
  let crop = CGRect(x: r[0] * 2, y: r[1] * 2, width: r[2] * 2, height: r[3] * 2).integral
  guard let part = img.cropping(to: crop) else { return nil }
  let cells = Sheet.cells(part, cell: 2)
  var lum: [Double] = []
  for row in cells {
    for c in row {
      let r = Double(c & 0xff)
      let g = Double((c >> 8) & 0xff)
      let b = Double((c >> 16) & 0xff)
      lum.append(r * 0.3 + g * 0.59 + b * 0.11)
    }
  }
  guard !lum.isEmpty else { return nil }
  let m = lum.reduce(0, +) / Double(lum.count)
  var v = 0.0
  for x in lum { v += (x - m) * (x - m) }
  return (v / Double(lum.count)).squareRoot()
}

@MainActor enum Scenarios {
  static var all: [Scenario] { [toolbar, panOverEditing, panOntoEditing, sectionTitleDrag, sectionFollowsDrag] }

  /// Linda's marked frame (04:32): a Section of Boxes, the last one dragged down inside it; the frame grows round it on
  /// every frame while a third of it is still in the frame the drag began with, then lets it go
  static var sectionFollowsDrag: Scenario {
    func box(_ id: String, _ text: String, x: Double, y: Double) -> Card {
      Card(
        id: CardID(rawValue: id), x: x, y: y, width: 180, section: SectionID(rawValue: "boxes"),
        content: .own(CardContent(body: .text(TextCard(text: text, look: .box, wrap: true)))))
    }
    let board = Board(
      id: BoardID(rawValue: "drive-boxes"),
      cards: [
        box("loop", "loop", x: 40, y: 60), box("join", "join", x: 260, y: 60), box("split", "split", x: 480, y: 60),
        box("plain", "plain", x: 40, y: 200), box("lookup", "lookup", x: 260, y: 200),
      ],
      sections: [Section(id: SectionID(rawValue: "boxes"), title: "Boxes", x: 0, y: 0, width: 700, height: 300)])
    return Scenario(
      name: "section-follows-drag",
      about: "a Box dragged down inside its Section: the frame grows with it, frame by frame",
      boards: [("Boxes", board)], sheetEvery: 3,
      checks: [
        { (frames: [Driver.Frame]) -> Verdict in
          let f = labelled(frames, "drag down")
          guard let first = f.first?.canvas?.sections["boxes"] else {
            return Verdict(check: "the frame holds the card", ok: false, detail: "no frames")
          }
          // where the card is a third or more inside the frame it began in, the frame holds it on every frame: its spring
          // runs a little behind the card, so the card may eat into the 22 below it, never past the frame's edge
          var out: [String] = []
          for x in f {
            guard let c = x.canvas?.cards["lookup"], let s = x.canvas?.sections["boxes"] else { continue }
            let inside = max(0, min(c[1] + c[3], first[1] + first[3]) - c[1]) * 3 > c[3]
            if inside, s[1] + s[3] < c[1] + c[3] {
              out.append("frame \(x.n): \(Int(s[1] + s[3])) < \(Int(c[1] + c[3]))")
            }
          }
          return Verdict(
            check: "the frame holds the card", ok: out.isEmpty,
            detail: out.isEmpty ? "every frame" : out.prefix(5).joined(separator: "; "))
        },
        { (frames: [Driver.Frame]) -> Verdict in
          // the drag happened: the card went down, and its frame grew while it was dragged
          let f = labelled(frames, "drag down")
          guard let a = f.first?.canvas, let b = f.last?.canvas, let ca = a.cards["lookup"], let cb = b.cards["lookup"],
            let sa = a.sections["boxes"], let sb = b.sections["boxes"]
          else { return Verdict(check: "the card was dragged", ok: false, detail: "no frames") }
          let down = cb[1] - ca[1]
          let grew = (f.compactMap { $0.canvas?.sections["boxes"].map { $0[1] + $0[3] } }.max() ?? 0) - (sa[1] + sa[3])
          return Verdict(
            check: "the card was dragged", ok: down > 50 && grew > 20,
            detail:
              "the card \(Int(down)) pt down, the frame at most \(Int(grew)) pt taller, at the end \(Int(sb[3] - sa[3]))"
          )
        },
      ],
      run: { d in
        await d.frames(4, "open")
        guard let p = d.centre(of: "lookup") else { return }
        await d.move(to: p, label: "to the card")
        await d.press(label: "drag down")
        // window points: y up
        await d.move(to: CGPoint(x: p.x, y: p.y - 180), speed: 3, label: "drag down")
        await d.frames(10, "drag down")
        await d.release(label: "drop")
        await d.frames(30, "rest")
      })
  }

  /// Linda's steps (04:29): a card written in, the fingers put down beside it and the board panned so the card comes
  /// under the still pointer, for a Note, a Text and a Box, with the system's momentum after the fingers lift too
  static var panOntoEditing: Scenario {
    let kinds: [(String, Card)] = [
      ("note", note("note", "## 调度器\n\n每一步先看等待队列。", x: 0, y: 0)),
      (
        "text",
        Card(
          id: CardID(rawValue: "text"), x: 420, y: 0, width: 260,
          content: .own(CardContent(body: .text(TextCard(text: "预填和解码", wrap: true)))))
      ),
      (
        "box",
        Card(
          id: CardID(rawValue: "box"), x: 760, y: 0, width: 260,
          content: .own(CardContent(body: .text(TextCard(text: "抢占最后进来的请求", look: .box, wrap: true)))))
      ),
    ]
    return Scenario(
      name: "pan-onto-editing",
      about:
        "two-finger pans that carry a card being written in under the still pointer: Note, Text, Box; with momentum",
      boards: [("Pan onto", Board(id: BoardID(rawValue: "drive-pan-onto"), cards: kinds.map(\.1)))], sheetEvery: 4,
      checks: kinds.flatMap { k -> [([Driver.Frame]) -> Verdict] in
        [false, true].map { m in
          { (frames: [Driver.Frame]) -> Verdict in
            let label = "\(k.0)\(m ? " with momentum" : ""): pan"
            let f = labelled(frames, label)
            // each step of the fingers moves the board 6 points, the card under the pointer or not
            var stalls: [Int] = []
            for (a, b) in zip(f, f.dropFirst()) {
              guard let ca = a.canvas?.camera, let cb = b.canvas?.camera else { continue }
              if abs((cb[1] - ca[1]) * cb[2]) < 1, b.label == a.label, b.n != f.last?.n { stalls.append(b.n) }
            }
            let under = f.contains { editorViews.contains($0.hit ?? "") }
            return Verdict(
              check: label + " carries the card under the pointer", ok: under && stalls.isEmpty && f.count > 10,
              detail: "editor under the pointer: \(under); frames where the board stood still: \(stalls.prefix(6))")
          }
        }
      },
      run: { d in
        await d.frames(4, "open")
        for (name, _) in kinds {
          for m in [false, true] {
            let label = "\(name)\(m ? " with momentum" : "")"
            guard let p = d.centre(of: name) else { continue }
            await d.move(to: p, label: "\(label): to the card")
            await d.doubleClick(label: "\(label): edit")
            await d.settle("the editor", until: { d.canvas?.isEditing == true })
            await d.frames(6, "\(label): editing")
            // just above the card, still; the board moves up under it
            guard let c = d.canvas, let r = c.trace.cards[name] else { continue }
            let above = c.convert(CGPoint(x: r[0] + r[2] / 2, y: r[1] - 40), to: nil)
            await d.move(to: above, label: "\(label): beside it")
            await d.scroll(dy: -6, steps: 24, momentum: m ? 20 : 0, label: "\(label): pan")
            await d.frames(6, "rest")
            // back where it was, and the writing ended
            await d.scroll(dy: 6, steps: 24, label: "back")
            await d.frames(4, "rest")
            await d.key(53, "\u{1b}", label: "\(label): leave")
            await d.settle("leaving", until: { d.canvas?.isEditing == false })
            await d.frames(4, "rest")
          }
        }
      })
  }

  /// A Section with two Notes and a Note outside it
  static func sectionBoard() -> Board {
    Board(
      id: BoardID(rawValue: "drive-section"),
      cards: [
        note("a", "## 预填\n\n整段 prompt 一次算完。", x: 40, y: 80, section: "s"),
        note("b", "## 解码\n\n每次一个 token。", x: 380, y: 80, section: "s"),
        note("out", "## 外面\n\n不在 Section 里。", x: 40, y: 420),
      ],
      sections: [Section(id: SectionID(rawValue: "s"), title: "调度", x: 0, y: 0, width: 740, height: 320)])
  }

  /// The Section's title pressed where it is drawn and dragged: the whole Section goes, its cards with it (board
  /// sectionLabelDown)
  static var sectionTitleDrag: Scenario {
    Scenario(
      name: "section-title-drag", about: "a Section dragged by its title, as the pointer finds the title on screen",
      boards: [("Section", sectionBoard())], sheetEvery: 2,
      checks: [
        { (frames: [Driver.Frame]) -> Verdict in
          let f = labelled(frames, "drag")
          guard let a = f.first?.canvas, let b = f.last?.canvas, let fa = a.sections["s"], let fb = b.sections["s"],
            let ca = a.cards["a"], let cb = b.cards["a"], let oa = a.cards["out"], let ob = b.cards["out"]
          else { return Verdict(check: "the Section moves", ok: false, detail: "no frames") }
          let moved = fb[0] - fa[0]
          let ok = abs(moved - 160) < 2 && abs(cb[0] - ca[0] - 160) < 2 && oa == ob
          return Verdict(
            check: "the Section moves", ok: ok,
            detail:
              "frame \(Int(moved)) pt, its card \(Int(cb[0] - ca[0])) pt, the card outside \(Int(ob[0] - oa[0])) pt; selected \(b.selection)"
          )
        }
      ],
      run: { d in
        await d.frames(4, "open")
        guard let c = d.canvas, let r = c.sectionTitle(SectionID(rawValue: "s")) else { return }
        let title = c.convert(c.currentCamera.view(CGPoint(x: r.midX, y: r.midY)), to: nil)
        await d.move(to: title, label: "to the title")
        await d.frames(8, "hover")
        await d.press(label: "drag")
        await d.move(to: CGPoint(x: title.x + 160, y: title.y), speed: 5, label: "drag")
        await d.release(label: "drag")
        await d.frames(6, "rest")
      })
  }

  /// A board with a few Notes, one big in the middle
  static func notesBoard() -> Board {
    Board(
      id: BoardID(rawValue: "drive-notes"),
      cards: [
        note("big", "# 调度器\n\n每一步先看等待队列，再决定预填还是解码。\n\n- 预填：整段 prompt\n- 解码：每次一个 token", x: 0, y: 0, w: 420),
        note("side", "## Block 管理\n\n按页分配 KV cache。", x: 520, y: 40),
        note("low", "## 抢占\n\nblock 不够就抢占最后进来的请求。", x: 60, y: 420),
      ])
  }

  /// The toolbar's tools drawn in the window, with nothing written in and with a Note being written in
  static var toolbar: Scenario {
    Scenario(
      name: "toolbar", about: "the bottom toolbar as the window shows it, idle and while a Note is written in",
      boards: [("Toolbar", notesBoard())], sheetEvery: 2,
      checks: [
        { (frames: [Driver.Frame]) -> Verdict in
          let shots = frames.filter { $0.image != nil && $0.toolbar != nil }
          let bad = shots.compactMap { f -> String? in
            guard let r = f.toolbar else { return nil }
            // the bar itself: the middle of the view, without the room around it for its shadow
            let bar = [r[0] + 40, r[1] + 40, max(1, r[2] - 80), max(1, r[3] - 80)]
            guard let s = spread(f, bar, in: Scenario.recording) else { return nil }
            return s < 12 ? "frame \(f.n) (\(f.label)): spread \(Int(s))" : nil
          }
          return Verdict(
            check: "toolbar has its tools", ok: bad.isEmpty && !shots.isEmpty,
            detail: bad.isEmpty ? "\(shots.count) frames: icons there" : bad.prefix(6).joined(separator: "; "))
        }
      ],
      run: { d in
        await d.frames(4, "open")
        // the pointer comes in from the left edge, onto the toolbar, over its tools one by one
        guard let c = d.canvas, let bar = d.window.contentView.flatMap({ d.find(CanvasToolbar.self, in: $0) }) else {
          return
        }
        _ = c
        let r = bar.convert(bar.bounds, to: nil)
        await d.move(to: CGPoint(x: 30, y: r.midY + 120), label: "in")
        await d.move(to: CGPoint(x: r.midX - 80, y: r.midY), label: "to the toolbar")
        await d.move(to: CGPoint(x: r.midX + 60, y: r.midY), speed: 3, label: "over the tools")
        // a Note written in: the pointer goes onto it, a double-click
        if let p = d.centre(of: "big") {
          await d.move(to: p, label: "to the Note")
          await d.doubleClick(label: "edit")
          await d.settle("the editor", until: { d.canvas?.isEditing == true })
          await d.frames(10, "editing")
          await d.move(to: CGPoint(x: r.midX, y: r.midY), label: "editing: to the toolbar")
          await d.frames(6, "editing")
        }
      })
  }

  /// A two-finger scroll and a pinch over a Note being written in, against the same over the bare board
  static var panOverEditing: Scenario {
    Scenario(
      name: "pan-over-editing",
      about: "scrolling and pinching the board over a Note in its editor, as over the bare board",
      boards: [("Pan", notesBoard())], sheetEvery: 3,
      checks: [
        { (frames: [Driver.Frame]) -> Verdict in
          // from the fingers down to the end of the glide after them
          func moved(_ p: String) -> Double? {
            guard let i = frames.firstIndex(where: { $0.label == p }) else { return nil }
            var j = i
            while j + 1 < frames.count, frames[j + 1].label == p || frames[j + 1].label == "rest" { j += 1 }
            guard let a = frames[i].canvas?.camera, let b = frames[j].canvas?.camera else { return nil }
            return (a[1] - b[1]) * b[2]
          }
          let bare = moved("bare scroll") ?? 0
          let over = moved("scroll over the editor") ?? 0
          let through = moved("scroll into the editor") ?? 0
          // the same fingers, the same glide; going in had ten more steps of 6 points
          let ok = abs(bare) > 50 && abs(over - bare) < 1 && abs(abs(through) - abs(bare) - 60) < 1
          return Verdict(
            check: "the board moves over the editor", ok: ok,
            detail:
              "bare board \(Int(bare)) pt, begun over the editor \(Int(over)) pt, begun outside and going in \(Int(through)) pt"
          )
        },
        { (frames: [Driver.Frame]) -> Verdict in
          func zoom(_ p: String) -> Double? {
            let f = labelled(frames, p)
            guard let a = f.first?.canvas?.camera, let b = f.last?.canvas?.camera else { return nil }
            return b[2] / a[2]
          }
          let bare = zoom("bare pinch") ?? 1
          let over = zoom("pinch over the editor") ?? 1
          return Verdict(
            check: "the board zooms over the editor", ok: bare > 1.05 && abs(over - bare) < 0.01,
            detail: "bare board ×\(String(format: "%.3f", bare)), over the editor ×\(String(format: "%.3f", over))")
        },
        { (frames: [Driver.Frame]) -> Verdict in
          let under = Set(labelled(frames, "scroll into the editor").compactMap(\.hit))
          return Verdict(
            check: "the Note came under the pointer", ok: !under.isDisjoint(with: editorViews),
            detail: "under the pointer meanwhile: \(under.sorted().joined(separator: ", "))")
        },
        { (frames: [Driver.Frame]) -> Verdict in
          let lost = labelled(frames, "scroll over the editor").filter { $0.canvas?.editing == nil }.count
          return Verdict(
            check: "still writing", ok: lost == 0,
            detail: lost == 0 ? "the Note stays in its editor" : "\(lost) frames not editing")
        },
      ],
      run: { d in
        await d.frames(4, "open")
        guard let big = d.centre(of: "big") else { return }
        let bare = CGPoint(x: big.x + 420, y: big.y - 260)
        await d.move(to: bare, label: "to the bare board")
        await d.scroll(dy: -6, steps: 20, label: "bare scroll")
        await d.frames(10, "rest")
        await d.scroll(dy: 6, steps: 20, label: "back")
        await d.frames(10, "rest")
        await d.pinch(by: 1.2, steps: 12, label: "bare pinch")
        await d.frames(6, "rest")
        await d.pinch(by: 1 / 1.2, steps: 12, label: "unpinch")
        await d.frames(6, "rest")
        guard let p = d.centre(of: "big") else { return }
        await d.move(to: p, label: "to the Note")
        await d.doubleClick(label: "edit")
        await d.settle("the editor", until: { d.canvas?.isEditing == true })
        await d.frames(10, "editing")
        await d.scroll(dy: -6, steps: 20, label: "scroll over the editor")
        await d.frames(10, "rest")
        await d.scroll(dy: 6, steps: 20, label: "back")
        await d.frames(10, "rest")
        // begun on the bare board just above the Note: the board moving up brings the Note under the pointer
        if let r = d.canvas?.trace.cards["big"], let c = d.canvas {
          let edge = c.convert(CGPoint(x: r[0] + r[2] / 2, y: r[1] - 30), to: nil)
          await d.move(to: edge, label: "past the Note's edge")
          await d.scroll(dy: -6, steps: 30, label: "scroll into the editor")
        }
        await d.frames(10, "rest")
        if let q = d.centre(of: "big") { await d.move(to: q, label: "to the Note") }
        await d.pinch(by: 1.2, steps: 12, label: "pinch over the editor")
        await d.frames(10, "rest")
      })
  }
}

extension Scenario {
  /// The recording's folder, for checks that look at its pictures
  @MainActor static var recording = URL(filePath: "/")
}
