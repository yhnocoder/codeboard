import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes
import QuartzCore

// LookCompare --refs <out folder>: clicks on [[refs]] on a board of made-up content, drawn off screen at 2x in each
// theme light and dark: a near card gone to and flashing, a far card's preview beside its Note, a card on another
// board previewed, a preview pulled in at the view's edge. <out>/<sheet>-<theme>[-dark].png

enum RefSheets {
  static let size = CGSize(width: 1200, height: 720)

  static func id(_ s: String) -> CardID { CardID(rawValue: s) }

  static func note(_ i: String, x: Double, y: Double, _ text: String) -> Card {
    Card(id: id(i), x: x, y: y, width: 320, content: .own(CardContent(body: .note(Note(text: text)))))
  }

  static func board() -> Board {
    let seg = Segment(
      id: SegmentID(rawValue: "s1"), source: .file(path: "engine/block_manager.py", hash: "77aa01"),
      language: "python", firstLine: 40,
      lines: [
        "def can_allocate(self, seq):", "    # 需要的块数", "    need = seq.num_blocks", "    free = len(self.free_ids)",
        "    if need > free:", "        return False", "    for i in range(need):", "        self.reserve(i)",
        "    self.used += need", "    log.debug('allocated %d', need)", "    return True", "    # 结束", "",
        "def free(self, seq):", "    for b in seq.blocks:", "        self.free_ids.append(b)",
      ], symbol: Symbol(name: "BlockManager.can_allocate", kind: .function))
    return Board(
      id: BoardID(rawValue: "ref-sheets"),
      cards: [
        note(
          "n1", x: 0, y: 0,
          "# 调度 Scheduling\n\n先看 [[预填 Prefill]]，再看 [[BlockManager.can_allocate]]。\n\n"
            + "缓存的事见 [[显存 Memory › 合并访问 Coalescing#^mem/m9]]。"),
        note("near", x: 760, y: 160, "# 预填 Prefill\n\n整段 prompt 一次过，之后一步一个 token。"),
        Card(
          id: id("far"), x: 5000, y: 3000, width: 460,
          content: .own(CardContent(body: .code(CodeCard(segments: [seg]))))),
      ])
  }

  static func memory() -> Board {
    Board(
      id: BoardID(rawValue: "mem"),
      cards: [
        note(
          "m9", x: 0, y: 0,
          "# 合并访问 Coalescing\n\nA warp's loads in one row of memory go as one request.\n\n- 连续的地址\n- 对齐到 128 字节")
      ])
  }

  @MainActor static func run(out: URL) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    Task { @MainActor in
      do {
        try await draw(out: out)
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

  @MainActor static func picture(_ r: Rig) async throws -> CGImage {
    var img = try EditSheets.render(r.canvas.layer!, size: size, scale: 2)
    if let peek = r.canvas.refPeek, let layer = peek.layer, let host = peek.superview {
      let f = r.canvas.convert(peek.frame, from: host)
      let shot = try EditSheets.render(layer, size: f.size, scale: 2)
      let ctx = CGContext(
        data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)!
      ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
      ctx.draw(
        shot,
        in: CGRect(
          x: f.minX * 2, y: CGFloat(img.height) - f.maxY * 2, width: CGFloat(shot.width), height: CGFloat(shot.height)))
      img = ctx.makeImage() ?? img
    }
    return img
  }

  @MainActor static func draw(out: URL) async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "look-refs-\(ProcessInfo.processInfo.processIdentifier)")
    defer { try? fm.removeItem(at: root) }
    try fm.createDirectory(at: out, withIntermediateDirectories: true)
    let notes = NoteRenderer(cache: root.appending(path: "cache"))
    for theme in Theme.all.flatMap({ [$0, Theme.named($0.id, dark: true)] }) {
      let suffix = theme.id.rawValue + (theme.dark ? "-dark" : "")
      let vault = root.appending(path: "vault")
      func rig(at c: CGPoint) async throws -> Rig {
        let r = try await Rig(
          root: vault, notes: notes, theme: theme, board: board(), others: [("显存 Memory", memory())], size: size,
          centre: c)
        r.canvas.refWait = .zero
        await r.until { r.canvas.refPoints(on: id("n1")).count == 3 }
        return r
      }
      func ref(_ r: Rig, _ k: Int) -> CGPoint { r.canvas.refPoints(on: id("n1"))[k] }
      func click(_ r: Rig, _ p: CGPoint) async {
        r.canvas.refClick(at: p)
        await r.until { r.canvas.refPeek?.ready == true || r.canvas.flashed != nil }
        await r.until { r.canvas.isResting }
        await r.canvas.drawAll()
      }

      // a near card: before the click | gone to, selected and flashing (an eighth of the way)
      var r = try await rig(at: CGPoint(x: 420, y: 260))
      var cuts = [try await picture(r)]
      await click(r, ref(r, 0))
      r.canvas.holdFlash(at: 0.12)
      cuts.append(try await picture(r))
      r.close()
      write(try WritingSheets.column(cuts, theme: theme), out, "near-\(suffix)")

      // a far card: its preview beside the Note at the ref, cut with a fade
      r = try await rig(at: CGPoint(x: 560, y: 300))
      await click(r, ref(r, 1))
      cuts = [try await picture(r)]
      r.canvas.closeRefPeek()
      // a card on another board
      await click(r, ref(r, 2))
      cuts.append(try await picture(r))
      r.close()
      write(try WritingSheets.column(cuts, theme: theme), out, "preview-\(suffix)")

      // no room on the right: pulled in 8 from the view's edge
      r = try await rig(at: CGPoint(x: 160, y: 300))
      await click(r, ref(r, 1))
      cuts = [try await picture(r)]
      r.close()
      write(try WritingSheets.column(cuts, theme: theme), out, "edge-\(suffix)")
    }
  }

  static func write(_ img: CGImage, _ out: URL, _ name: String) { EditSheets.write(img, out, name) }
}
