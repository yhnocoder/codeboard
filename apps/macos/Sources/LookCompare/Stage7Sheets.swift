import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes
import ImageIO

// LookCompare --stage7 <out folder> <main's pictures>: stickers, the Shelf, Web cards and Link Lists on boards made from
// the data of main's Storybook stories (review/stage7/capture-main.mjs captures them), drawn off
// screen at 2x in each theme light and dark, each beside main's story where main has one. <out>/<sheet>-<theme>.png

enum Stage7Sheets {
  static let size = CGSize(width: 1500, height: 900)
  /// main's stories put board (0, 0) at view (40, 41)
  static let centre = CGPoint(x: 710, y: 409)

  static func cid(_ s: String) -> CardID { CardID(rawValue: s) }
  static func kid(_ s: String) -> StickerID { StickerID(rawValue: s) }

  // MARK: The stories' pages (stories/support/cards.ts PAGES)

  static let full = (
    "https://arxiv.org/abs/2309.06180",
    WebMeta(
      title: "Efficient Memory Management for Large Language Model Serving with PagedAttention",
      description:
        "High throughput serving of large language models (LLMs) requires batching sufficiently many requests at a time. However, existing systems struggle because the key-value cache memory for each request is huge.",
      site: "arXiv.org", image: .file("og-full.png"), icon: .file("fav-a.png"), fetchedAt: 1)
  )
  static let square = (
    "https://flashinfer.ai/2024/02/02/cascade-inference.html",
    WebMeta(
      title: "FlashInfer: paged KV layout and cascade inference",
      description: "Cascade inference with shared prefix KV-cache.", image: .file("og-square.png"),
      icon: .file("fav-F.png"), fetchedAt: 1)
  )
  static let noImage = (
    "https://github.com/GeeeekExplorer/nano-vllm",
    WebMeta(
      title: "nano-vllm: A lightweight vLLM implementation built from scratch",
      description:
        "Fast offline inference in ~1,200 lines of readable Python, with prefix caching, tensor parallelism, CUDA graphs and torch compilation.",
      site: "GitHub", icon: .file("fav-gh.png"), fetchedAt: 1)
  )
  static let titleOnly = (
    "https://triton-lang.org/main/python-api/triton.language.html",
    WebMeta(title: "Triton Language Reference", icon: .file("fav-T.png"), fetchedAt: 1)
  )
  static let failed = (
    "https://docs.internal.company/wiki/kv-cache-design/a-very-long-page-name-that-keeps-going-and-going?tab=notes&rev=2025-10-16T04:15:00Z&from=board",
    WebMeta(fetchedAt: 1, failed: true)
  )
  static let images = ["og-full", "og-square", "fav-a", "fav-F", "fav-gh", "fav-T"]

  static func web(
    _ id: String, _ page: (String, WebMeta)?, x: Double, y: Double, w: Double, style: WebCard.Style = .automatic,
    url: String? = nil
  ) -> Card {
    Card(
      id: cid(id), x: x, y: y, width: w,
      content: .own(
        CardContent(body: .web(WebCard(url: url ?? page?.0 ?? "https://example.com/slow", meta: page?.1, style: style)))
      )
    )
  }

  static func links(
    _ id: String, _ pages: [(String, WebMeta)], x: Double, y: Double, w: Double, rich: Bool = false,
    richRows: [Int] = [], title: String? = nil
  ) -> Card {
    let items = pages.enumerated().map { i, p in
      LinkList.Item(id: "\(id)-i\(i)", url: p.0, meta: p.1, rich: richRows.contains(i) ? true : nil)
    }
    return Card(
      id: cid(id), x: x, y: y, width: w,
      content: .own(CardContent(title: title, body: .links(LinkList(items: items, rich: rich)))))
  }

  /// Web styles (the story's grid: three across, 420 apart, 400 down, each 380 wide)
  static func styles() -> Board {
    let all: [WebCard.Style] = [.automatic, .banner, .side, .text, .compact]
    return Board(
      id: BoardID(rawValue: "styles"),
      cards: all.enumerated().map { i, s in
        web("ws-\(i)", full, x: 40 + Double(i % 3) * 420, y: 40 + Double(i / 3) * 400, w: 380, style: s)
      })
  }

  /// Link Lists (the story's five)
  static func lists() -> Board {
    let list = [full, noImage, titleOnly, failed, square]
    return Board(
      id: BoardID(rawValue: "lists"),
      cards: [
        links("ll-compact", list, x: 40, y: 40, w: 420, title: "KV Cache Reading"),
        links("ll-rich", Array(list.prefix(3)), x: 520, y: 40, w: 440, rich: true),
        links("ll-mixed", list, x: 1020, y: 40, w: 420, richRows: [0, 2]),
        links("ll-sel", Array(list.prefix(3)), x: 40, y: 420, w: 420),
        links("ll-fetch", [noImage, failed], x: 40, y: 620, w: 420, richRows: [1]),
      ])
  }

  static func code(_ id: String, x: Double, y: Double, w: Double) -> Card {
    let seg = Segment(
      id: SegmentID(rawValue: "s-\(id)"), source: .file(path: "nanovllm/engine/scheduler.py", hash: nil),
      language: "python", firstLine: 75,
      lines: [
        "def preempt(self, seq: Sequence):", "    seq.status = SequenceStatus.WAITING", "    seq.is_prefill = True",
        "    self.block_manager.deallocate(seq)", "    self.waiting.appendleft(seq)",
      ], symbol: Symbol(name: "Scheduler.preempt", kind: .function))
    return Card(id: cid(id), x: x, y: y, width: w, content: .own(CardContent(body: .code(CodeCard(segments: [seg])))))
  }

  /// The stickers overview (its built-in, colour, size and emoji rows, a code card with stickers on it and on its
  /// lines, and a selected one); the folder pack row is not there: packs are not imported
  static func stickers() -> Board {
    var b = Board(id: BoardID(rawValue: "stickers"), cards: [code("st-c", x: 960, y: 80, w: 460)])
    func free(_ id: String, _ g: Sticker.Glyph, _ x: Double, _ y: Double, _ size: Double = 36, color: String? = nil) {
      b.stickers.append(Sticker(id: kid(id), glyph: g, color: color, anchor: .canvas(x: x, y: y, size: size)))
    }
    for (i, g) in BuiltinSticker.allCases.enumerated() { free("bi-\(i)", .builtin(g), 40 + Double(i) * 56, 40) }
    for (i, c) in Sticker.palette.enumerated() {
      free("col-\(i)", .builtin(.star), 40 + Double(i) * 56, 160, color: c)
    }
    var x = 40.0
    for (i, s) in [16.0, 24, 32, 48, 72, 120].enumerated() {
      free("sz-\(i)", .builtin(.star), x, 280, s)
      x += s + 20
    }
    let emoji = Array("⭐❗✅🚩⚡🐞📌❤️⏳⚠️💡🔥👀🤔🧪🧠🚀🐢🔒📝🎯🧩🔍📊🧮🛠️🗑️✨🎉😵🙃").map(String.init)
    for (i, e) in emoji.enumerated() {
      free("em-\(i)", .emoji(e), 40 + Double(i % 16) * 48, 460 + Double(i / 16) * 48, 32)
    }
    let seg = SegmentID(rawValue: "s-st-c")
    b.stickers += [
      Sticker(id: kid("on-card"), glyph: .builtin(.flag), anchor: .card(cid("st-c"), x: 300, y: 70, size: 48)),
      Sticker(id: kid("line-1"), glyph: .builtin(.star), anchor: .line(cid("st-c"), segment: seg, line: 76)),
      Sticker(id: kid("line-2"), glyph: .builtin(.zap), anchor: .line(cid("st-c"), segment: seg, line: 78)),
      Sticker(id: kid("line-2b"), glyph: .builtin(.todoText), anchor: .line(cid("st-c"), segment: seg, line: 78)),
    ]
    free("sel", .builtin(.heart), 960, 440, 56)
    return b
  }

  /// The palette story's board: a star on the canvas, a code card and a Note
  static func paletteBoard() -> Board {
    var b = Board(
      id: BoardID(rawValue: "palette"),
      cards: [
        code("c", x: 40, y: 200, w: 440),
        Card(
          id: cid("n"), x: 760, y: 220, width: 240,
          content: .own(CardContent(body: .note(Note(text: "释放 block 后回到等待队列"))))),
      ])
    b.stickers = [Sticker(id: kid("k"), glyph: .builtin(.star), anchor: .canvas(x: 200, y: 60, size: 48))]
    return b
  }

  /// A board with things on its Shelf: a Note alone, a Section with its two cards, two Notes put in together
  static func shelf(empty: Bool) -> Board {
    func note(_ id: String, _ t: String, x: Double, y: Double) -> Card {
      Card(id: cid(id), x: x, y: y, width: 260, content: .own(CardContent(body: .note(Note(text: t)))))
    }
    var b = Board(
      id: BoardID(rawValue: "shelf"),
      cards: [
        code("keep", x: 40, y: 60, w: 460), note("n1", "## 抢占\n\nblock 不够就抢占最后进来的请求。", x: 560, y: 60),
        code("s1", x: 80, y: 360, w: 420), code("s2", x: 540, y: 360, w: 300),
        note("n2", "**等待队列**：被抢占的请求排到最前面", x: 40, y: 640),
        note("n3", "Prefill 和 decode 分开调度", x: 340, y: 660),
      ],
      sections: [
        Section(
          id: SectionID(rawValue: "sec"), title: "Preempt", x: 60, y: 310, width: 800, height: 220, color: "blue")
      ])
    for i in b.cards.indices where ["s1", "s2"].contains(b.cards[i].id.rawValue) {
      b.cards[i].section = SectionID(rawValue: "sec")
    }
    guard !empty else { return b }
    b.shelve(cards: [cid("n1")], sections: [], id: "e1", at: 1)
    b.shelve(cards: [], sections: [SectionID(rawValue: "sec")], id: "e2", at: 2)
    b.shelve(cards: [cid("n2"), cid("n3")], sections: [], id: "e3", at: 3)
    return b
  }

  @MainActor static func run(out: URL, main: URL) -> Never {
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

  /// A part of the canvas (view points) with what is over it, at 2x
  @MainActor static func cut(_ r: Rig, _ rect: CGRect) throws -> CGImage {
    let img = try EditSheets.render(r.canvas.layer!, size: r.canvas.bounds.size, scale: 2)
    return img.cropping(to: CGRect(x: rect.minX * 2, y: rect.minY * 2, width: rect.width * 2, height: rect.height * 2))
      ?? img
  }

  static func mainCut(_ main: URL, _ name: String, _ rect: CGRect? = nil) -> CGImage? {
    guard let img = Stage6Sheets.load(main.appending(path: "\(name).png")) else { return nil }
    guard let r = rect else { return img }
    return img.cropping(to: CGRect(x: r.minX * 2, y: r.minY * 2, width: r.width * 2, height: r.height * 2))
  }

  @MainActor static func draw(out: URL, main: URL) async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "look-stage7-\(ProcessInfo.processInfo.processIdentifier)")
    defer { try? fm.removeItem(at: root) }
    try fm.createDirectory(at: out, withIntermediateDirectories: true)
    let notes = NoteRenderer(cache: root.appending(path: "cache"))
    let vault = root.appending(path: "vault")
    let pictures = images.map { main.appending(path: "\($0).png") }
    let all = CGRect(origin: .zero, size: size)
    for theme in Theme.all.flatMap({ [$0, Theme.named($0.id, dark: true)] }) {
      let suffix = theme.id.rawValue + (theme.dark ? "-dark" : "")
      func rig(_ b: Board, centre c: CGPoint = centre) async throws -> Rig {
        let r = try await Rig(
          root: vault, notes: notes, theme: theme, board: b, others: [], size: size, centre: c, images: pictures)
        await r.canvas.drawAll()
        return r
      }
      func sheet(_ name: String, _ story: String?, _ ours: CGImage, mainRect: CGRect? = nil) throws {
        var row = [ours]
        if let story, let m = mainCut(main, "\(story)-\(suffix)", mainRect) { row.insert(m, at: 0) }
        EditSheets.write(try WritingSheets.row(row, theme: theme), out, "\(name)-\(suffix)")
      }

      // Web styles
      var r = try await rig(styles())
      try sheet(
        "web-styles", "cards-web--styles", try cut(r, CGRect(x: 0, y: 0, width: 1300, height: 840)),
        mainRect: CGRect(x: 0, y: 0, width: 1300, height: 840))
      r.close()

      // Link Lists, one selected, one row being read
      r = try await rig(lists())
      r.doc.select([.card(cid("ll-sel"))])
      r.canvas.webFetching.insert("ll-fetch/ll-fetch-i1")
      r.canvas.refresh()
      await r.canvas.refreshing?.value
      await r.canvas.drawAll()
      try sheet("link-lists", "cards-web--link-lists", try cut(r, all))
      r.close()

      // a failed read, and one being read (the stories' single cards, 340 wide)
      r = try await rig(
        Board(
          id: BoardID(rawValue: "states"),
          cards: [
            web("w-failed", failed, x: 40, y: 40, w: 340),
            web("w-fetch", nil, x: 540, y: 40, w: 340, url: "https://example.com/slow"),
          ]))
      r.canvas.webFetching.insert("w-fetch")
      r.canvas.refresh()
      await r.canvas.refreshing?.value
      await r.canvas.drawAll()
      let state = CGRect(x: 0, y: 0, width: 440, height: 300)
      var cuts = [try cut(r, state), try cut(r, state.offsetBy(dx: 500, dy: 0))]
      if let m = mainCut(main, "cards-web--fetching-\(suffix)", state) { cuts.insert(m, at: 1) }
      if let m = mainCut(main, "cards-web--failed-\(suffix)", state) { cuts.insert(m, at: 0) }
      EditSheets.write(try WritingSheets.row(cuts, theme: theme), out, "web-failed-fetching-\(suffix)")
      r.close()

      // stickers: every glyph, colour and size, emoji, on a card and its lines, one selected with its grip
      r = try await rig(stickers())
      r.doc.select([.sticker(kid("sel"))])
      await r.canvas.drawAll()
      try sheet("stickers", "canvas-stickers--overview", try cut(r, all))
      // its menu's colour row (the menu itself is macOS's), put where the menu would open
      let swatches = StickerSwatches(theme: theme, own: BuiltinSticker.heart.color, current: "#4C8BF5")
      swatches.frame = CGRect(origin: CGPoint(x: 1000, y: 540), size: swatches.fittingSize)
      r.canvas.addSubview(swatches)
      await r.canvas.drawAll()
      EditSheets.write(
        try cut(r, CGRect(x: 960, y: 440, width: 420, height: 200)), out, "sticker-selected-menu-\(suffix)")
      r.close()

      // the palette, open over a Sticker button at the bottom
      r = try await rig(paletteBoard())
      r.canvas.toggleStickerPalette(above: CGRect(x: 730, y: 850, width: 40, height: 36))
      await r.canvas.drawAll()
      let p = r.canvas.stickerPalette?.frame ?? all
      try sheet(
        "palette", "canvas-stickers--picker-built-in", try cut(r, p.insetBy(dx: -24, dy: -24)),
        mainRect: CGRect(x: 340, y: 292, width: 360, height: 240))
      r.canvas.closeStickerPalette()
      r.close()

      // the Shelf: empty, its entries with one hovered (its outline on the board), the large picture
      r = try await rig(shelf(empty: true), centre: CGPoint(x: 600, y: 400))
      r.canvas.toggleShelf()
      await r.canvas.drawAll()
      EditSheets.write(try cut(r, all), out, "shelf-empty-\(suffix)")
      r.close()
      r = try await rig(shelf(empty: false), centre: CGPoint(x: 600, y: 400))
      r.canvas.toggleShelf()
      await r.until { r.canvas.shelfPictures.count == 3 }
      r.canvas.showHome("e2")
      await r.canvas.drawAll()
      EditSheets.write(try cut(r, all), out, "shelf-entries-\(suffix)")
      r.canvas.showHome(nil)
      r.canvas.togglePreview("e3")
      await r.until { r.canvas.shelfPreview?.image != nil }
      try? await Task.sleep(for: .milliseconds(400))
      await r.canvas.drawAll()
      EditSheets.write(try cut(r, all), out, "shelf-preview-\(suffix)")
      r.close()
    }
    try report.write(to: out.appending(path: "report.txt"), atomically: true, encoding: .utf8)
  }

  static let report = """
    Stage 7 look sheets: made-up content only (the pages and boards of main's Storybook stories), drawn off screen at
    2x by `swift run -c release LookCompare --stage7 <out> <main's pictures>`, in Warm Ink and Ink Wash, light and dark
    (<sheet>-<theme>[-dark].png). Where main has a story, its picture (Storybook in headless Chromium, 2x) is on the left
    and ours on the right.

    web-styles: the five Web styles (Auto, Banner, Side, Text, Compact) of the same page, 380 wide. main's captions are
    story labels, not cards, so ours has none.
    link-lists: Compact rows (titled), Rich rows (View ▸ Rich), Mixed (rows 1 and 3 Rich), Selected, a Rich row being
    read (looks the same).
    web-failed-fetching: main's Nothing Fetched | ours | main's Fetching Preview | ours.
    stickers: every built-in glyph (no "?": questions are sidenotes), the star in each palette colour, sizes 16 to 120,
    emoji as the system draws them, a flag on the code card and stickers on its lines (76: star; 78: zap and TODO), the
    heart selected with its grip. Not drawn: main's folder-pack row (packs are not imported), its corner and arrow
    stickers (not in this stage), its sidenote on line 76.
    sticker-selected-menu: the selected heart and the colour row its right-click menu starts with (macOS draws the menu
    around it with Delete under it; a native menu cannot be drawn off screen).
    palette: main's picker (with its tabs, search, colours and pack line) | ours: the built-in glyphs, TODO two wide,
    and the emoji button, which opens the system's emoji picker.
    shelf-empty: the panel open with nothing in it. main has no Shelf story.
    shelf-entries: three entries in board order (a Section with its cards as one picture, two Notes put in together as
    one), the Section's entry hovered: its outline on the board where it returns. The panel's glass is a
    NSVisualEffectView, whose blur is not drawn off screen.
    shelf-preview: the two Notes' entry clicked: the large picture left of the panel, level with its thumbnail, with
    its one button (Put Back).
    """
}
