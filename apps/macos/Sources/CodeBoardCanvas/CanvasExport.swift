import AppKit
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import UniformTypeIdentifiers

// ⋯ Export… (board ui/ExportDialog.tsx, actions/export.ts; host exports.ts exportFile, handlers.ts exportPng): main's
// dialog as a sheet on the window, then where to save it asked in the save panel. Markdown is core's (CodeBoardModel
// Export.swift) of what the dialog picks; PNG is the whole board as the canvas draws it at rest, nothing selected, at 2
// pixels a unit with 40 around it. Not made: the HTML snapshot (main clones its web board's page, which the app has
// not) and Export Boards… (a .codeboard holds main's board files, which the app does not write yet).

/// What the dialog picks (state/export.ts ExportOpts)
struct ExportOptions: Equatable {
  enum Format { case markdown, png }
  enum What: Int { case board, sections, walk }
  var format = Format.markdown
  var what = What.board
  var sections: [SectionID] = []
  var questions = false
  var boardOnly = false
}

extension CanvasView {
  /// The most pixels a PNG export is drawn with: a board too large for 2 pixels a unit within this is drawn at the
  /// scale that fits (main's page would fail to draw it at all)
  static let pngPixels: CGFloat = 64 * 1024 * 1024
  /// The longest side a PNG export is drawn with
  static let pngSide: CGFloat = 16384

  /// Where a walkthrough export starts (actions/export.ts walkStart): the one card selected. The app has no Start
  /// cards and no call graphs to start from otherwise
  var walkStart: CardID? {
    let cards = (document?.selection ?? []).compactMap(\.card)
    return cards.count == 1 ? cards[0] : nil
  }

  /// ⋯ Export… (openExport): the Sections picked at first are those selected, else those of the cards selected, else
  /// the first
  func openExport() {
    guard let doc = document, let (vb, _) = shown, let window, exportSheet == nil else { return }
    let b = doc.board
    let sel = doc.selection
    var secs = b.sections.map(\.id).filter { sel.contains(.section($0)) }
    if secs.isEmpty {
      let of = Set(sel.compactMap { $0.card.flatMap { b.card($0)?.section } })
      secs = b.sections.map(\.id).filter(of.contains)
    }
    let start = walkStart.flatMap { id in b.card(id).map { c in (id, Self.title(c)) } }
    let sheet = ExportSheet(
      name: vb.title, sections: b.sections, walk: start?.1,
      look: "\(theme.name) · \(theme.dark ? "Dark" : "Light")",
      options: ExportOptions(sections: secs.isEmpty ? Array(b.sections.prefix(1).map(\.id)) : secs))
    exportSheet = sheet
    sheet.onExport = { [weak self, weak sheet] o in
      guard let self, let sheet else { return }
      Task { await self.runExport(o, sheet: sheet, start: start?.0) }
    }
    // let go once the sheet is off the window: a window freed while its sheet ends stops the main run loop
    window.beginSheet(sheet.window) { [weak self] _ in self?.exportSheet = nil }
  }

  /// A card's title as core's cardTitle gives it
  static func title(_ c: Card) -> String {
    if case .own(let k) = c.content { cardTitle(k) } else { "" }
  }

  /// Export (runExport): Markdown asks where on the dialog, which stays until the file is written; PNG closes the
  /// dialog first
  func runExport(_ o: ExportOptions, sheet: ExportSheet, start: CardID?) async {
    guard !sheet.busy, let doc = document, let (vb, vault) = shown, let window else { return }
    let b = doc.board
    if o.format == .png {
      sheet.close()
      return await exportPNG(b, name: vb.title, vault: vault, on: window)
    }
    let scope: ExportScope =
      switch o.what {
      case .board: .board
      case .sections: .sections(o.sections)
      case .walk: start.map { .walk($0) } ?? .board
      }
    sheet.busy = true
    defer { sheet.busy = false }
    guard let order = try? await notes.exportOrder(b, scope) else { return toast("Export failed") }
    guard !order.isEmpty else { return toast("Nothing to export in this scope") }
    var links: [SegmentID: String] = [:]
    for id in order {
      var segs: [Segment] = []
      if case .own(let k)? = b.card(id)?.content, case .code(let code) = k.body { segs += code.segments }
      for n in b.sidenotes where n.anchor.card == id { if case .code(let s) = n.body { segs.append(s) } }
      for s in segs { links[s.id] = segmentPermalink(s) }
    }
    let blocks = await noteBlocks(b, order)
    let titles = Dictionary(
      ((try? vault.tree())?.allBoards ?? []).map { ($0.id, $0.title) }, uniquingKeysWith: { a, _ in a })
    let text = b.markdown(
      order: order, title: vb.title, questions: o.questions, boardOnly: o.boardOnly, links: links,
      boardName: { titles[$0] }, blocks: { blocks[$0] ?? nil })
    guard
      let file = await save(
        name: "\(exportFileName(vb.title)).md", type: UTType(filenameExtension: "md") ?? .plainText, vault: vault,
        on: sheet.window)
    else { return }
    do {
      try Data(text.utf8).write(to: file, options: .atomic)
    } catch {
      return toast("Export failed: \(error.localizedDescription)")
    }
    sheet.close()
    toast("Exported \(file.lastPathComponent)")
  }

  /// The Note page's blocks of each Note an arrow of these cards ends on a block of
  private func noteBlocks(_ b: Board, _ order: [CardID]) async -> [String: [String]?] {
    let ids = Set(order)
    var mds: [String] = []
    for a in b.arrows where ids.contains(a.from.card) {
      for e in [a.from, a.to] where e.block != nil {
        guard case .own(let k)? = b.card(e.card)?.content else { continue }
        switch k.body {
        case .note(let n): mds.append(n.text)
        case .text(let t): mds.append(t.text)
        default: break
        }
      }
    }
    let unique = Array(Set(mds))
    guard !unique.isEmpty, let got = try? await notes.blocks(of: unique) else { return [:] }
    return Dictionary(zip(unique, got).map { ($0, $1) }, uniquingKeysWith: { a, _ in a })
  }

  /// exportPng: the board's cards and Sections and 40 around, at 2 pixels a unit, on the theme's canvas colour (the
  /// picture behind the board is the page's, not the board's)
  func exportPNG(_ b: Board, name: String, vault: Vault, on window: NSWindow) async {
    guard let s = scene, let (vb, _) = shown else { return }
    let box = (s.items.filter { if case .card = $0.owner { true } else { false } }.map(\.rect) + s.frames.map(\.rect))
      .reduce(CGRect.null) { $0.union($1) }
    guard !box.isNull else { return toast("Nothing to export") }
    let pad: CGFloat = 40
    let size = CGSize(width: (box.width + 2 * pad).rounded(.up), height: (box.height + 2 * pad).rounded(.up))
    let scale = min(
      2, (Self.pngPixels / (size.width * size.height)).squareRoot(), Self.pngSide / max(size.width, size.height))
    let rect = CGRect(x: box.minX - pad, y: box.minY - pad, width: size.width, height: size.height)
    let theme = self.theme
    let notes = self.notes
    let highlighter = CanvasView.highlighter ?? Highlighter()
    let package = vault.url(of: vb.path)
    let image = await Picture.draw(
      board: b, package: package, vault: vault, theme: theme, highlighter: highlighter, notes: notes, rect: rect,
      scale: scale, backdrop: false
    ).image
    let data = NSMutableData()
    guard let image, let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)
    else { return toast("Export failed") }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { return toast("Export failed") }
    guard let file = await save(name: "\(exportFileName(name)).png", type: .png, vault: vault, on: window) else {
      return
    }
    do {
      try (data as Data).write(to: file, options: .atomic)
    } catch {
      return toast("Export failed: \(error.localizedDescription)")
    }
    toast("Exported \(file.lastPathComponent)")
  }

  /// Where to save (host saveDialog): the file name main gives, in the vault, as a sheet on `window`
  private func save(name: String, type: UTType, vault: Vault, on window: NSWindow) async -> URL? {
    await saveFile(SaveRequest(name: name, type: type, folder: vault.root), window)
  }

  static func askSaveFile(_ r: SaveRequest, _ window: NSWindow) async -> URL? {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = r.name
    panel.allowedContentTypes = [r.type]
    panel.directoryURL = r.folder
    panel.canCreateDirectories = true
    return await panel.beginSheetModal(for: window) == .OK ? panel.url : nil
  }
}

/// What the save panel is asked with
package struct SaveRequest {
  package var name: String
  package var type: UTType
  package var folder: URL
}

/// The Export dialog (ExportDialog.tsx): Format, What (and the Sections, or where the walkthrough starts), Include,
/// Look, File; Cancel (Esc) and Export (Return)
@MainActor final class ExportSheet: NSObject {
  let window: NSWindow
  var onExport: ((ExportOptions) -> Void)?
  /// Writing: Export says so and does nothing
  var busy = false {
    didSet { update() }
  }
  private var o: ExportOptions
  private let name: String
  private let hasSections: Bool
  private let walk: String?
  private let formats = NSSegmentedControl(
    labels: ["Markdown", "PNG"], trackingMode: .selectOne, target: nil, action: nil)
  private let what: NSSegmentedControl
  private let sectionBoxes: [(SectionID, NSButton)]
  private let sectionList = NSScrollView()
  private let walkNote = NSTextField(labelWithString: "")
  private let questions = NSButton(checkboxWithTitle: "Questions", target: nil, action: nil)
  private let boardOnly = NSButton(checkboxWithTitle: "Board-only notes", target: nil, action: nil)
  private let file = NSTextField(labelWithString: "")
  private let export = NSButton(title: "Export", target: nil, action: nil)
  private var grid: NSGridView!

  init(name: String, sections: [Section], walk: String?, look: String, options: ExportOptions) {
    self.name = name
    self.walk = walk
    o = options
    hasSections = !sections.isEmpty
    what = NSSegmentedControl(
      labels: ["Whole Board", "Selected Sections", "Walkthrough"], trackingMode: .selectOne, target: nil, action: nil)
    sectionBoxes = sections.map { s in
      let t = s.title.trimmingCharacters(in: .whitespaces)
      return (s.id, NSButton(checkboxWithTitle: t.isEmpty ? "Untitled" : s.title, target: nil, action: nil))
    }
    window = NSPanel(
      contentRect: CGRect(x: 0, y: 0, width: 520, height: 300), styleMask: [.titled, .docModalWindow],
      backing: .buffered, defer: false)
    super.init()
    window.isReleasedWhenClosed = false
    for c in [formats, what] as [NSControl] + [questions, boardOnly] + sectionBoxes.map(\.1) {
      c.target = self
      c.action = #selector(changed(_:))
    }
    what.setToolTip(hasSections ? nil : "No sections on this board", forSegment: 1)
    what.setToolTip(walk.map { "From \($0)" } ?? "Select a card first", forSegment: 2)
    let title = NSTextField(labelWithString: "Export Board · \(name)")
    title.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
    let boxes = NSStackView(views: sectionBoxes.map(\.1))
    boxes.orientation = .vertical
    boxes.alignment = .leading
    boxes.spacing = 4
    boxes.edgeInsets = NSEdgeInsets(top: 2, left: 2, bottom: 2, right: 2)
    sectionList.documentView = boxes
    sectionList.drawsBackground = false
    sectionList.hasVerticalScroller = true
    sectionList.autohidesScrollers = true
    sectionList.borderType = .noBorder
    // the dialog keeps one size whatever is picked: nothing below moves, and the sheet is never resized while it is up
    let below = NSView()
    for v in [sectionList, walkNote] as [NSView] {
      v.translatesAutoresizingMaskIntoConstraints = false
      below.addSubview(v)
    }
    let rows = CGFloat(max(1, min(5, sectionBoxes.count)))
    NSLayoutConstraint.activate([
      below.heightAnchor.constraint(equalToConstant: rows * 22 + 4),
      below.widthAnchor.constraint(equalToConstant: 380),
      sectionList.leadingAnchor.constraint(equalTo: below.leadingAnchor),
      sectionList.trailingAnchor.constraint(equalTo: below.trailingAnchor),
      sectionList.topAnchor.constraint(equalTo: below.topAnchor),
      sectionList.bottomAnchor.constraint(equalTo: below.bottomAnchor),
      walkNote.leadingAnchor.constraint(equalTo: below.leadingAnchor),
      walkNote.trailingAnchor.constraint(lessThanOrEqualTo: below.trailingAnchor),
      walkNote.topAnchor.constraint(equalTo: below.topAnchor),
      boxes.leadingAnchor.constraint(equalTo: sectionList.contentView.leadingAnchor),
      boxes.topAnchor.constraint(equalTo: sectionList.contentView.topAnchor),
    ])
    boxes.translatesAutoresizingMaskIntoConstraints = false
    let include = NSStackView(views: [questions, boardOnly])
    include.spacing = 16
    walkNote.stringValue = walk.map { "From \($0), following its arrows" } ?? ""
    for l in [walkNote, file] {
      l.textColor = .secondaryLabelColor
      l.lineBreakMode = .byTruncatingMiddle
    }
    file.widthAnchor.constraint(equalToConstant: 380).isActive = true
    let lookNote = NSTextField(labelWithString: "Current theme · \(look)")
    lookNote.textColor = .secondaryLabelColor
    func label(_ s: String) -> NSTextField { NSTextField(labelWithString: s) }
    grid = NSGridView(views: [
      [label("Format"), formats],
      [label("What"), what],
      [NSGridCell.emptyContentView, below],
      [label("Include"), include],
      [label("Look"), lookNote],
      [label("File"), file],
    ])
    grid.rowSpacing = 10
    grid.column(at: 0).xPlacement = .trailing
    grid.rowAlignment = .firstBaseline
    let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancel(_:)))
    cancel.keyEquivalent = "\u{1b}"
    export.target = self
    export.action = #selector(go(_:))
    export.keyEquivalent = "\r"
    let buttons = NSStackView(views: [cancel, export])
    let all = NSStackView(views: [title, grid, buttons])
    all.orientation = .vertical
    all.alignment = .leading
    all.spacing = 16
    all.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
    buttons.translatesAutoresizingMaskIntoConstraints = false
    window.contentView = all
    buttons.trailingAnchor.constraint(equalTo: all.trailingAnchor, constant: -20).isActive = true
    // wide enough for "Exporting…": the button keeps its size
    export.widthAnchor.constraint(greaterThanOrEqualToConstant: 96).isActive = true
    update()
  }

  /// The picks shown: PNG is the whole board, without What or Include
  private func update() {
    let png = o.format == .png
    formats.selectedSegment = png ? 1 : 0
    what.selectedSegment = png ? 0 : o.what.rawValue
    what.isEnabled = !png
    what.setEnabled(hasSections, forSegment: 1)
    what.setEnabled(walk != nil, forSegment: 2)
    for (id, b) in sectionBoxes { b.state = o.sections.contains(id) ? .on : .off }
    sectionList.isHidden = png || o.what != .sections
    walkNote.isHidden = png || o.what != .walk || walk == nil
    questions.state = o.questions ? .on : .off
    boardOnly.state = o.boardOnly ? .on : .off
    questions.isEnabled = !png
    boardOnly.isEnabled = !png
    let fileName = name.trimmingCharacters(in: .whitespaces)
    file.stringValue =
      png
      ? "\(fileName.isEmpty ? "board" : fileName).png · whole board as an image"
      : "\(fileName.isEmpty ? "board" : fileName).md · cards in walkthrough order · GitHub permalinks"
    let label = busy ? "Exporting…" : "Export"
    if export.title != label { export.title = label }
    export.isEnabled = !busy && (png || o.what != .sections || !o.sections.isEmpty)
  }

  @objc private func changed(_ sender: NSControl) {
    switch sender {
    case formats: o.format = formats.selectedSegment == 1 ? .png : .markdown
    case what: o.what = ExportOptions.What(rawValue: what.selectedSegment) ?? .board
    case questions: o.questions = questions.state == .on
    case boardOnly: o.boardOnly = boardOnly.state == .on
    default:
      if let (id, b) = sectionBoxes.first(where: { $0.1 === sender }) {
        o.sections.removeAll { $0 == id }
        if b.state == .on { o.sections.append(id) }
      }
    }
    update()
  }

  @objc private func go(_ sender: Any?) {
    guard export.isEnabled else { return }
    onExport?(o)
  }

  @objc private func cancel(_ sender: Any?) { close() }

  func close() { window.sheetParent?.endSheet(window) }
}
