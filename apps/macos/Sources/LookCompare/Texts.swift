import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import Foundation

// LookCompare --texts <out folder>: Texts and Boxes of made-up content drawn as the canvas shows them at rest (the Note
// page's picture over the canvas's paper), at several sizes, in every fill, wrapped and not, in each theme light and dark:
// <out>/texts-<theme>[-dark].png. Rows: a Text, then a Box in each fill; columns: 14, 20, 30 and 48 px as wide as the
// text, then 16 and 24 px wrapped at 220 and 300.

enum TextSheets {
  static let columns: [(fontSize: Double, wrap: Double?, x: Double)] = [
    (14, nil, 0), (20, nil, 260), (30, nil, 600), (48, nil, 1080), (16, 220, 1800), (24, 300, 2080),
  ]
  static let short = "## Prefill\n\nIt **batches** the prompt\n\n- one `token`\n- then ==two=="
  static let long =
    "Wrapped at the card's width, this text runs on to the next line, with **bold**, *italic*, `code` and a [link](https://example.org)."

  static func board() -> Board {
    var cards: [Card] = []
    let looks: [(TextCard.Look, BoxFill)] = [(.text, .yellow)] + BoxFill.allCases.map { (.box, $0) }
    for (row, (look, fill)) in looks.enumerated() {
      for (col, c) in columns.enumerated() {
        let text = TextCard(
          text: c.wrap == nil ? short : long, look: look, fill: fill, fontSize: c.fontSize, wrap: c.wrap != nil)
        cards.append(
          Card(
            id: CardID(rawValue: "t\(row)-\(col)"), x: c.x, y: Double(row) * 420, width: c.wrap ?? 300,
            content: .own(CardContent(body: .text(text)))))
      }
    }
    return Board(id: BoardID(rawValue: "texts"), cards: cards)
  }

  static func run(out: URL) -> Never {
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

  @MainActor static func draw(out: URL) async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "look-texts-\(ProcessInfo.processInfo.processIdentifier)")
    defer { try? fm.removeItem(at: root) }
    let package = root.appending(path: "Texts.board")
    try fm.createDirectory(at: package, withIntermediateDirectories: true)
    try fm.createDirectory(at: out, withIntermediateDirectories: true)
    let b = board()
    try b.encoded().write(to: package.appending(path: Vault.boardFileName))
    let vault = Vault(root: root)
    // a cache of its own: never the app's
    let notes = NoteRenderer(cache: root.appending(path: "cache"))
    let highlighter = Highlighter()
    for theme in Theme.all.flatMap({ [$0, Theme.named($0.id, dark: true)] }) {
      let name = "texts-" + theme.id.rawValue + (theme.dark ? "-dark" : "")
      let first = await Picture.draw(
        board: b, package: package, vault: vault, theme: theme, highlighter: highlighter, notes: notes,
        rect: CGRect(x: 0, y: 0, width: 1, height: 1), scale: 1, backdrop: false)
      let bounds = first.cards.values.reduce(CGRect.null) { $0.union($1) }.insetBy(dx: -40, dy: -40)
      let (img, _) = await Picture.draw(
        board: b, package: package, vault: vault, theme: theme, highlighter: highlighter, notes: notes, rect: bounds,
        scale: 2, backdrop: true)
      guard let img else { throw CocoaError(.fileWriteUnknown) }
      write(img, out.appending(path: "\(name).png"))
      print("\(name).png \(img.width)×\(img.height)")
    }
  }
}
