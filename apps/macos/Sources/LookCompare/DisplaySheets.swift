import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import Foundation

// LookCompare --displays <out folder> [names…]: the Markdown the canvas shows at rest drawn by both Note displays, the
// web page's (NoteRenderer) and the native component's (NativeNotes), card by card as the canvas draws it (its paper,
// header and fill under each picture): every tools/markdown/look/*.md as a Note 360 wide and the Texts and Boxes of
// look/cards.json, in each theme light and dark. <out>/<theme>[-dark]/<name>.png is web | native | difference;
// <out>/report.txt has each card's size from both (as the page and the component measure it, before the canvas rounds
// it), where a Text's first glyph is, how far a Note's blocks moved, and the mean difference of the pictures.

enum DisplaySheets {
  struct Sample {
    var name: String
    var body: CardContent.Body
    var width: Double
  }

  static let looks = URL(filePath: #filePath).deletingLastPathComponent()
    .appending(path: "../../tools/markdown/look").standardized

  static func samples(_ only: Set<String>) throws -> [Sample] {
    let fm = FileManager.default
    var out: [Sample] = []
    for f in try fm.contentsOfDirectory(atPath: looks.path(percentEncoded: false)).sorted() where f.hasSuffix(".md") {
      let text = try String(contentsOf: looks.appending(path: f), encoding: .utf8)
      out.append(Sample(name: String(f.dropLast(3)), body: .note(Note(text: text)), width: 360))
    }
    struct Card: Decodable {
      struct Style: Decodable {
        struct T: Decodable {
          var fontSize: Double?
          var wrap: Bool?
          var fill: String?
        }
        var text: T?
        var box: T?
      }
      var name: String
      var style: Style
      var width: Double
      var text: String
    }
    let cards = try JSONDecoder().decode([Card].self, from: Data(contentsOf: looks.appending(path: "cards.json")))
    for c in cards {
      let s = c.style.box ?? c.style.text
      let t = TextCard(
        text: c.text, look: c.style.box == nil ? .text : .box,
        fill: s?.fill.flatMap(BoxFill.init(rawValue:)) ?? .yellow,
        fontSize: s?.fontSize ?? 20, wrap: s?.wrap ?? false)
      out.append(Sample(name: c.name, body: .text(t), width: c.width))
    }
    return out.filter { only.isEmpty || only.contains($0.name) }
  }

  @MainActor static func run(out: URL, only: Set<String>) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    Task { @MainActor in
      do {
        try await draw(out: out, only: only)
        exit(0)
      } catch {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        exit(1)
      }
    }
    app.run()
    exit(0)
  }

  @MainActor static func draw(out: URL, only: Set<String>) async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "look-displays-\(ProcessInfo.processInfo.processIdentifier)")
    defer { try? fm.removeItem(at: root) }
    let package = root.appending(path: "Displays.board")
    try fm.createDirectory(at: package, withIntermediateDirectories: true)
    try fm.copyItem(at: looks.appending(path: "images"), to: package.appending(path: "images"))
    try fm.createDirectory(at: out, withIntermediateDirectories: true)
    let vault = Vault(root: root)
    // a cache of its own: never the app's
    let web = NoteRenderer(cache: root.appending(path: "cache"))
    let native = NativeNotes(web: web)
    let displays: [(String, any NoteDisplay)] = [("web", web), ("native", native)]
    let highlighter = Highlighter()
    let list = try samples(only)
    var report = "card\ttheme\tweb w×h\tnative w×h\tΔw\tΔh\tfirst glyph Δ\tblocks Δy (max)\tmean diff\n"
    for theme in Theme.all.flatMap({ [$0, Theme.named($0.id, dark: true)] }) {
      let name = theme.id.rawValue + (theme.dark ? "-dark" : "")
      let dir = out.appending(path: name)
      try fm.createDirectory(at: dir, withIntermediateDirectories: true)
      for s in list {
        let card = CodeBoardModel.Card(
          id: CardID(rawValue: s.name), x: 0, y: 0, width: s.width, content: .own(CardContent(body: s.body)))
        let b = Board(id: BoardID(rawValue: "displays"), cards: [card])
        try b.encoded().write(to: package.appending(path: Vault.boardFileName))
        let note: NoteBody =
          switch s.body {
          case .text(let t): .text(t)
          case .note(let n): .note(n)
          default: .inline("")
          }
        let req = NoteSizeRequest(
          note: note, width: s.width, folder: package, look: theme.id.rawValue, dark: theme.dark)
        var shots: [CGImage] = []
        var metrics: [NoteMetrics?] = []
        var firsts: [CGPoint?] = []
        for (_, d) in displays {
          metrics.append(try await d.metrics(of: [req], priority: 0)[0])
          firsts.append(try await d.firstGlyphs(of: [req])[0]?.first)
          let at = await Picture.draw(
            board: b, package: package, vault: vault, theme: theme, highlighter: highlighter, display: d,
            rect: CGRect(x: 0, y: 0, width: 1, height: 1), scale: 1, backdrop: false)
          let r = (at.cards[s.name] ?? .zero).insetBy(dx: -16, dy: -16)
          let (img, _) = await Picture.draw(
            board: b, package: package, vault: vault, theme: theme, highlighter: highlighter, display: d, rect: r,
            scale: 2, backdrop: true)
          guard let img else { throw CocoaError(.fileWriteUnknown) }
          shots.append(img)
        }
        let (pair, mean) = pairUp(shots[0], shots[1])
        if let pair { write(pair, dir.appending(path: "\(s.name).png")) }
        func size(_ m: NoteMetrics?) -> String {
          m.map { String(format: "%.2f×%.2f", $0.size.width, $0.size.height) } ?? "—"
        }
        let (a, c) = (metrics[0]?.size ?? .zero, metrics[1]?.size ?? .zero)
        var glyph = "—"
        if let w = firsts[0], let n = firsts[1] { glyph = String(format: "%+.2f, %+.2f", n.x - w.x, n.y - w.y) }
        var moved = "—"
        if let wb = metrics[0]?.blocks, let nb = metrics[1]?.blocks {
          moved =
            wb.count == nb.count
            ? String(format: "%.2f", zip(wb, nb).map { abs($1.y - $0.y) }.max() ?? 0)
            : "\(wb.count) vs \(nb.count) blocks"
        }
        report +=
          "\(s.name)\t\(name)\t\(size(metrics[0]))\t\(size(metrics[1]))\t"
          + String(format: "%+.2f\t%+.2f\t", c.width - a.width, c.height - a.height)
          + "\(glyph)\t\(moved)\t" + String(format: "%.2f", mean) + "\n"
        print(s.name, name, size(metrics[0]), size(metrics[1]))
      }
    }
    try report.write(to: out.appending(path: "report.txt"), atomically: true, encoding: .utf8)
  }

  /// web | native | difference (dark where they differ, ×4), and the mean difference per pixel (0…255), as the main
  /// comparison's sideBySide; its own colour space, as main.swift's globals are not made yet when this runs
  static func pairUp(_ web: CGImage, _ native: CGImage) -> (CGImage?, Double) {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let w = max(web.width, native.width)
    let h = max(web.height, native.height)
    func px(_ img: CGImage) -> [UInt8] {
      var p = [UInt8](repeating: 0, count: w * h * 4)
      p.withUnsafeMutableBytes { buf in
        let ctx = CGContext(
          data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        ctx?.draw(img, in: CGRect(x: 0, y: h - img.height, width: img.width, height: img.height))
      }
      return p
    }
    let a = px(web)
    let b = px(native)
    var diff = [UInt8](repeating: 255, count: w * h * 4)
    var total = 0
    for i in stride(from: 0, to: a.count, by: 4) {
      var d = 0
      for c in 0..<3 { d = max(d, abs(Int(a[i + c]) - Int(b[i + c]))) }
      total += d
      let v = UInt8(max(0, 255 - min(255, d * 4)))
      diff[i] = v
      diff[i + 1] = v
      diff[i + 2] = v
    }
    let gap = 12
    let ctx = CGContext(
      data: nil, width: 3 * w + 2 * gap, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    ctx?.setFillColor(CGColor(gray: 0.5, alpha: 1))
    ctx?.fill(CGRect(x: 0, y: 0, width: 3 * w + 2 * gap, height: h))
    let d = diff.withUnsafeMutableBytes { buf in
      CGContext(
        data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage()
    }
    for (i, img) in [web, native, d].enumerated() {
      guard let img else { continue }
      ctx?.draw(img, in: CGRect(x: i * (w + gap), y: h - img.height, width: img.width, height: img.height))
    }
    return (ctx?.makeImage(), Double(total) / Double(w * h))
  }
}
