import AppKit
import CodeBoardCanvas
import CodeBoardModel

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
  static var all: [Scenario] { [toolbar, panOverEditing] }

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
            check: "the Note came under the pointer", ok: under.contains("EditorWebView"),
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
  nonisolated(unsafe) static var recording = URL(filePath: "/")
}
