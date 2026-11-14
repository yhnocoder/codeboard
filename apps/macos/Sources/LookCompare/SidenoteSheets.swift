import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes
import QuartzCore
import WebKit

// LookCompare --sidenotes <out folder>: sidenotes on a board of made-up content, drawn off screen at 2x in each theme
// light and dark: <out>/<sheet>-<theme>[-dark].png. The canvas is drawn by Core Animation; the popup and the question
// list are web views over it, drawn by WebKit's snapshot of each where it is.

enum SidenoteSheets {
  static let size = CGSize(width: 1400, height: 760)

  static func id(_ s: String) -> CardID { CardID(rawValue: s) }
  static func nid(_ s: String) -> SidenoteID { SidenoteID(rawValue: s) }
  static let s1 = SegmentID(rawValue: "s1")
  static let g1 = SectionID(rawValue: "g1")
  static let noteText = "# 调度 Scheduling\n\nRequests wait in the queue until a slot is free.\n\n- 每一步取一批\n- 再算一步"
  static let block = BlockRef(index: 1, hash: BlockRef.sig("Requests wait in the queue until a slot is free."))

  static func board() -> Board {
    let seg = Segment(
      id: s1, source: .file(path: "engine/scheduler.py", hash: "9f3e2a1c"), language: "python", firstLine: 10,
      lines: [
        "def schedule(self):", "    # 取出等待的请求", "    batch = self.waiting.take(8)", "    for seq in batch:",
        "        self.running.append(seq)", "    return batch",
      ], symbol: Symbol(name: "Scheduler.schedule", kind: .function), highlights: [12...13])
    let long = Segment(
      id: SegmentID(rawValue: "k1"), source: .file(path: "engine/block_manager.py", hash: "77aa01"), language: "python",
      firstLine: 40,
      lines: [
        "def can_allocate(self, seq):", "    # 需要的块数", "    need = seq.num_blocks", "    free = len(self.free_ids)",
        "    if need > free:", "        return False", "    for i in range(need):", "        self.reserve(i)",
        "    self.used += need", "    log.debug('allocated %d', need)", "    return True", "",
      ], symbol: Symbol(name: "BlockManager.can_allocate", kind: .function))
    func text(_ t: String, q: Question? = nil) -> Sidenote.Body { .text(TextNote(text: t, question: q)) }
    var answered = Question(at: 2000)
    answered.answers = [Question.Answer(id: "a1", text: "因为 **prefill** 一次要整段 prompt，见 [[调度 Scheduling]]。", at: 3000)]
    var resolved = Question(at: 1000)
    resolved.done = true
    return Board(
      id: BoardID(rawValue: "sidenote-sheets"),
      cards: [
        Card(id: id("c1"), x: 0, y: 0, width: 440, content: .own(CardContent(body: .code(CodeCard(segments: [seg]))))),
        Card(
          id: id("n1"), x: 620, y: 40, width: 300, section: g1,
          content: .own(CardContent(body: .note(Note(text: noteText))))),
        Card(
          id: id("t1"), x: 0, y: 330, width: 220,
          content: .own(CardContent(body: .text(TextCard(text: "预填 Prefill：整段 prompt 一次过", wrap: true))))),
      ],
      sections: [Section(id: g1, title: "调度 Section", x: 580, y: -40, width: 400, height: 380)],
      sidenotes: [
        Sidenote(
          id: nid("l1"), anchor: .card(id("c1"), segment: s1, lines: 12...13), body: text("一次最多取 8 个请求。")),
        Sidenote(
          id: nid("l2"), anchor: .card(id("c1"), segment: s1, lines: 12...13),
          body: text("为什么是 8？和 block 数有关吗？", q: answered)),
        Sidenote(
          id: nid("l3"), anchor: .card(id("c1"), segment: s1, lines: 12...13),
          body: text("取出时会不会饿死长请求？", q: resolved)),
        Sidenote(id: nid("w1"), anchor: .card(id("n1")), body: text("整张卡：先 prefill 再 decode。", q: Question(at: 4000))),
        Sidenote(id: nid("b1"), anchor: .card(id("n1"), block: block), body: text("这一段说的是等待队列 waiting queue。")),
        Sidenote(id: nid("g1"), anchor: .section(g1), body: text("这一组讲调度的一步。")),
        Sidenote(id: nid("f1"), anchor: .point(x: 400, y: 540), body: text("自由的旁注：之后再看 decode。")),
        Sidenote(id: nid("k1"), anchor: .card(id("t1")), body: .code(long)),
      ])
  }

  /// Another board with a question of its own, for the list of every board's
  static func other() -> Board {
    Board(
      id: BoardID(rawValue: "other-board"), cards: [],
      sidenotes: [
        Sidenote(
          id: nid("o1"), anchor: .point(x: 0, y: 0),
          body: .text(TextNote(text: "KV cache 的块多大？", question: Question(at: 500))))
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

  @MainActor final class Rig {
    let canvas: CanvasView
    let window: NSWindow
    let doc: BoardDocument

    init(
      root: URL, notes: NoteRenderer, theme: Theme, zoom: CGFloat = 1, board: Board = SidenoteSheets.board(),
      others: [(String, Board)] = [("Other", SidenoteSheets.other())], size: CGSize = SidenoteSheets.size,
      centre: CGPoint, sheet: String = "Sheet"
    ) async throws {
      let fm = FileManager.default
      try? fm.removeItem(at: root)
      for (name, b) in [(sheet, board)] + others {
        let package = root.appending(path: "\(name).board")
        try fm.createDirectory(at: package.appending(path: Vault.imagesFolder), withIntermediateDirectories: true)
        try b.encoded().write(to: package.appending(path: Vault.boardFileName))
      }
      let file = root.appending(path: "\(sheet).board").appending(path: Vault.boardFileName)
      doc = try BoardDocument { file }
      canvas = CanvasView(frame: CGRect(origin: .zero, size: size), notes: notes)
      window = NSWindow(
        contentRect: CGRect(origin: CGPoint(x: -30000, y: -30000), size: size), styleMask: [.titled],
        backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false
      let host = NSView(frame: canvas.frame)
      host.addSubview(canvas)
      window.contentView = host
      canvas.noteEditor.drawOffScreen()
      canvas.sidenotePop.drawOffScreen()
      canvas.questionList.drawOffScreen()
      window.orderFrontRegardless()
      // a folder board ("<folder>/.folder") is titled with its folder's name
      let parts = sheet.split(separator: "/").map(String.init)
      let own = parts.last == ".folder"
      let at = VaultBoard(
        id: doc.id, title: own ? parts.dropLast().last ?? "" : parts.last ?? "", path: "\(sheet).board",
        isFolderBoard: own)
      try await canvas.show(doc, at: at, in: Vault(root: root), theme: theme)
      canvas.place(zoom: zoom, centre: centre)
      await canvas.drawAll()
    }

    func close() {
      canvas.showPop(nil)
      canvas.closeQuestionList()
      window.orderOut(nil)
      window.close()
    }

    func until(_ f: () async -> Bool) async {
      let deadline = ContinuousClock.now + .seconds(20)
      while await !f(), ContinuousClock.now < deadline {
        canvas.tick(at: CACurrentMediaTime())
        try? await Task.sleep(for: .milliseconds(5))
      }
    }

    /// The popup for `at` open and drawn
    func open(_ at: PopAt, write: Bool = false) async {
      canvas.showPop(at, write: write)
      await until { canvas.popShownAt == at && canvas.sidenotePop.view.alphaValue == 1 }
      await frames()
    }

    func frames() async {
      _ = await canvas.sidenotePop.run(
        "for (let i = 0; i < 6; i++) await new Promise(r => requestAnimationFrame(r)); return 1")
      await canvas.drawAll()
    }

    func js(_ s: String, _ args: [String: Any] = [:]) async -> Any? { await canvas.sidenotePop.run(s, args) }

    /// The canvas with the popup and the list drawn over it where they are
    func picture() async throws -> CGImage {
      var img = try EditSheets.render(canvas.layer!, size: SidenoteSheets.size, scale: 2)
      for view in [canvas.sidenotePop.view as WKWebView, canvas.questionList.view] where view.alphaValue > 0 {
        img = try await over(img, view)
      }
      return img
    }

    func over(_ base: CGImage, _ view: WKWebView) async throws -> CGImage {
      let c = WKSnapshotConfiguration()
      c.afterScreenUpdates = true
      let image = try await view.takeSnapshot(configuration: c)
      guard let web = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
        let ctx = CGContext(
          data: nil, width: base.width, height: base.height, bitsPerComponent: 8, bytesPerRow: 0,
          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)
      else { return base }
      let f = canvas.convert(view.frame, from: view.superview)
      ctx.draw(base, in: CGRect(x: 0, y: 0, width: base.width, height: base.height))
      ctx.draw(
        web, in: CGRect(x: f.minX * 2, y: CGFloat(base.height) - f.maxY * 2, width: f.width * 2, height: f.height * 2))
      return ctx.makeImage() ?? base
    }

    /// A part of a picture, view points
    func cut(_ img: CGImage, _ r: CGRect) -> CGImage {
      let v = r.intersection(CGRect(origin: .zero, size: SidenoteSheets.size))
      return img.cropping(to: CGRect(x: v.minX * 2, y: v.minY * 2, width: v.width * 2, height: v.height * 2).integral)
        ?? img
    }

    /// Around the popup and its marker
    func aroundPop(_ img: CGImage, _ at: PopAt) -> CGImage {
      var r = canvas.popBox ?? .zero
      if let m = canvas.markCentre(at) {
        let p = canvas.viewPoint(m)
        r = r.union(CGRect(x: p.x - 30, y: p.y - 30, width: 60, height: 60))
      }
      return cut(img, r.insetBy(dx: -40, dy: -40))
    }
  }

  @MainActor static func draw(out: URL) async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "look-sidenotes-\(ProcessInfo.processInfo.processIdentifier)")
    defer { try? fm.removeItem(at: root) }
    try fm.createDirectory(at: out, withIntermediateDirectories: true)
    let notes = NoteRenderer(cache: root.appending(path: "cache"))
    let centre = CGPoint(x: 640, y: 300)
    let lines = PopAt.lines(Lines(card: id("c1"), segment: s1, range: 12...13))
    let card = PopAt.spot(.card(id("n1")))
    let blockAt = PopAt.spot(.block(id("n1"), block))
    let section = PopAt.spot(.section(g1))
    let free = PopAt.spot(.point(x: 400, y: 540))
    let code = PopAt.spot(.card(id("t1")))
    for theme in Theme.all.flatMap({ [$0, Theme.named($0.id, dark: true)] }) {
      let suffix = theme.id.rawValue + (theme.dark ? "-dark" : "")
      let vault = root.appending(path: "vault")
      func rig(zoom: CGFloat = 1, at c: CGPoint = centre) async throws -> Rig {
        try await Rig(root: vault, notes: notes, theme: theme, zoom: zoom, centre: c)
      }

      // markers for each kind of anchor: at 100 % | zoomed out to 40 %
      var r = try await rig()
      var cuts = [try await r.picture()]
      r.close()
      r = try await rig(zoom: 0.4, at: centre)
      cuts.append(try await r.picture())
      r.close()
      write(try WritingSheets.column(cuts, theme: theme), out, "markers-\(suffix)")

      // the popup of lines, a whole card, a Note's block, a Section and a free marker
      cuts = []
      r = try await rig()
      for at in [lines, card, blockAt, section, free] {
        // room on the right of each
        r.canvas.place(zoom: 1, centre: CGPoint(x: [lines, free].contains(at) ? 640 : 900, y: 300))
        await r.canvas.drawAll()
        await r.open(at)
        cuts.append(r.aroundPop(try await r.picture(), at))
        r.canvas.showPop(nil)
        await r.until { r.canvas.popShownAt == nil }
      }
      r.close()
      write(try WritingSheets.column(cuts, theme: theme), out, "popups-\(suffix)")

      // no room on its right: over the card, in the window | dragged away, the dashed line back to its marker
      r = try await rig(at: CGPoint(x: 260, y: 300))
      await r.open(card)
      cuts = [try await r.picture()]
      r.close()
      r = try await rig()
      await r.open(card)
      r.canvas.dragPopBy(CGSize(width: -380, height: 240))
      await r.frames()
      cuts.append(try await r.picture())
      r.close()
      write(try WritingSheets.column(cuts, theme: theme), out, "place-\(suffix)")

      // the composer: the + | the input (the Notes' editor), with the [[ list open
      r = try await rig()
      await r.open(blockAt)
      cuts = [r.aroundPop(try await r.picture(), blockAt)]
      r.canvas.showPop(nil)
      await r.until { r.canvas.popShownAt == nil }
      await r.open(blockAt, write: true)
      await r.until { await r.js("return !!document.querySelector('.ncomp .ProseMirror')") as? Bool == true }
      // the [[ list comes with the candidates, read once the popup is open
      try? await Task.sleep(for: .milliseconds(400))
      _ = await r.js("pop.type(t)", ["t": "参见 [[调"])
      await r.until { await r.js("return !!document.querySelector('.md-pick')") as? Bool == true }
      await r.frames()
      let typed = try await r.picture()
      var box = (r.canvas.popBox ?? .zero).insetBy(dx: -40, dy: -40)
      box.size.height += 300
      cuts.append(r.cut(typed, box))
      r.close()
      write(try WritingSheets.column(cuts, theme: theme), out, "composer-\(suffix)")

      // questions: open with an answer, resolved, a plain one | the reply row writing an answer | the ? toggle on
      r = try await rig()
      await r.open(lines)
      cuts = [r.aroundPop(try await r.picture(), lines)]
      _ = await r.js("pop.click('.reply')")
      await r.until { await r.js("return !!document.querySelector('.ans-in .ProseMirror')") as? Bool == true }
      _ = await r.js("pop.type(t)", ["t": "和 KV cache 的块数有关。"])
      await r.frames()
      cuts.append(r.aroundPop(try await r.picture(), lines))
      r.canvas.showPop(nil)
      await r.until { r.canvas.popShownAt == nil }
      // what was written there was added as its answer; the board's own again for the next
      r.close()
      r = try await rig()
      await r.open(card, write: true)
      await r.until { await r.js("return !!document.querySelector('.ncomp .ProseMirror')") as? Bool == true }
      _ = await r.js("pop.click('.ncomp-ask')")
      _ = await r.js("pop.type(t)", ["t": "decode 一步要多久？"])
      await r.frames()
      cuts.append(r.aroundPop(try await r.picture(), card))
      r.close()
      write(try WritingSheets.column(cuts, theme: theme), out, "questions-\(suffix)")

      // a long code sidenote: cut at 8 lines with a fade | opened
      r = try await rig()
      await r.open(code)
      cuts = [r.aroundPop(try await r.picture(), code)]
      _ = await r.js("pop.click('.sn-code.long')")
      await r.frames()
      cuts.append(r.aroundPop(try await r.picture(), code))
      r.close()
      write(try WritingSheets.column(cuts, theme: theme), out, "code-\(suffix)")

      // the toolbar's ? with its list open: this board's | every board's
      r = try await rig()
      let bar = CanvasToolbar(frame: .zero)
      bar.theme = theme
      bar.zoom = 1
      bar.questions = 2
      bar.listOpen = true
      let barSize = bar.intrinsicContentSize
      let barOrigin = CGPoint(
        x: (size.width - barSize.width) / 2, y: size.height - (12 - CanvasToolbar.margin) - barSize.height)
      let q = bar.questionsRect!.offsetBy(dx: barOrigin.x, dy: barOrigin.y)
      r.canvas.toggleQuestionList(under: q)
      await r.until { r.canvas.questionList.view.alphaValue == 1 }
      try? await Task.sleep(for: .milliseconds(200))
      cuts = [try ArrowSheets.withBar(try await r.picture(), bar)]
      _ = await r.canvas.questionList.run("document.querySelector('.qlist-clear').click()")
      try? await Task.sleep(for: .milliseconds(200))
      cuts.append(try ArrowSheets.withBar(try await r.picture(), bar))
      r.close()
      write(try WritingSheets.column(cuts, theme: theme), out, "list-\(suffix)")

      // beside main's popup drawn in Chromium (the Storybook story cards-sidenote-pops--whole-card, its element alone):
      // the same card and sidenote, the popup's box alone
      let scheme = theme.dark ? "dark" : "light"
      if let dir = ProcessInfo.processInfo.environment["MAIN_POPS"],
        let main = NSImage(contentsOfFile: "\(dir)/main-\(theme.id.rawValue)-\(scheme).png")?
          .cgImage(forProposedRect: nil, context: nil, hints: nil)
      {
        let seg = Segment(
          id: s1, source: .file(path: "engine/scheduler.py", hash: nil), language: "python", firstLine: 25,
          lines: ["def schedule(self):", "    return self.step()"],
          symbol: Symbol(name: "Scheduler.schedule", kind: .function))
        let b = Board(
          id: BoardID(rawValue: "compare"),
          cards: [
            Card(
              id: id("h"), x: 0, y: 0, width: 360, content: .own(CardContent(body: .code(CodeCard(segments: [seg])))))
          ],
          sidenotes: [
            Sidenote(id: nid("c"), anchor: .card(id("h")), body: .text(TextNote(text: "整张卡：调度一步，先 prefill 再 decode")))
          ])
        r = try await Rig(root: vault, notes: notes, theme: theme, board: b, centre: CGPoint(x: 500, y: 200))
        await r.open(.spot(.card(id("h"))))
        let mac = r.cut(try await r.picture(), r.canvas.popBox ?? .zero)
        r.close()
        write(try WritingSheets.row([main, mac], theme: theme), out, "beside-main-\(suffix)")
      }
    }
  }

  static func write(_ img: CGImage, _ out: URL, _ name: String) { EditSheets.write(img, out, name) }
}
