// A window to try the Markdown component in, standing alone (no canvas, no board): a Markdown file laid out as a Note
// card in the board's looks, with the editor over it. ⌘O opens another file; tools/markdown/make-demo.sh makes an app.
//   swift run MarkdownDemo [file.md] [--width 420]
// The card is a picture until clicked, as on the board: a click on it edits there, a click beside it or Esc ends editing.
// The toolbar switches the look (Warm Ink, Ink Wash), light and dark, and the zoom (50 to 200 %, also ⌥⌘= ⌥⌘- ⌥⌘0). Images
// are read relative to the file. Typing edits the text shown; the file is never written.
import AppKit
import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CodeBoardModel
import CodeBoardSyntax
import CodeBoardTestGuard
import ImageIO

/// Images next to the file, formulas and diagrams through the engines, code coloured by the app's highlighter
/// (CodeBoardSyntax); no references
/// Pictures pasted or dropped into the demo: kept in memory under the address written for them (the demo never writes a
/// file)
final class Pasted: @unchecked Sendable {
  private let lock = NSLock()
  private var pictures: [String: CGImage] = [:]
  func add(_ data: Data) -> String? {
    guard let s = CGImageSourceCreateWithData(data as CFData, nil), let i = CGImageSourceCreateImageAtIndex(s, 0, nil)
    else { return nil }
    return lock.withLock {
      let name = "pasted/\(pictures.count + 1).png"
      pictures[name] = i
      return name
    }
  }
  func picture(_ src: String) -> CGImage? { lock.withLock { pictures[src] } }
}

struct FileResources: MarkdownResources {
  let folder: URL
  let pasted: Pasted
  let math: MathTypesetter?
  let highlighter = Highlighter()
  /// a fence's language as the highlighter names its grammars
  static let grammars: [String: String] = [
    "python": "python", "py": "python", "python3": "python", "triton": "triton", "tilelang": "tilelang", "c": "c",
    "h": "c", "cpp": "cpp", "c++": "cpp", "cc": "cpp", "cxx": "cpp", "hpp": "cpp", "cuda": "cuda-cpp", "cu": "cuda-cpp",
    "cuh": "cuda-cpp", "cuda-cpp": "cuda-cpp", "rust": "rust", "rs": "rust",
  ]
  static let kinds: [TokenClass: MarkdownTokenKind] = [
    .keyword: .keyword, .operator: .operator, .function: .function, .string: .string, .comment: .comment,
    .number: .number, .receiver: .receiver, .punctuation: .punctuation,
  ]
  var diagrams: DiagramRenderer? { math as? DiagramRenderer }
  func imageSize(_ src: String) -> CGSize? {
    if let p = pasted.picture(src) { return CGSize(width: p.width, height: p.height) }
    if !src.contains("://"), let d = try? Data(contentsOf: folder.appending(path: src)), MarkdownSVG.isSVG(d) {
      return MarkdownSVG.size(d)
    }
    guard !src.contains("://"), let s = CGImageSourceCreateWithURL(folder.appending(path: src) as CFURL, nil),
      let p = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any],
      let w = p[kCGImagePropertyPixelWidth] as? Int, let h = p[kCGImagePropertyPixelHeight] as? Int
    else { return nil }
    return CGSize(width: w, height: h)
  }
  /// the demo's own cards, without a vault: a few names its sample Note's references resolve to (a vault's references
  /// are its own cards)
  static let sampleCards = ["reference", "Scheduler", "Block manager", "Prefill", "Decode"]
  func ref(label: String, target: String?) -> MarkdownRefHit? {
    Self.sampleCards.contains { $0.caseInsensitiveCompare(label) == .orderedSame }
      ? .found(title: label, seal: nil) : nil
  }
  func highlight(lines: [String], language: String) -> [[MarkdownToken]]? {
    guard let grammar = Self.grammars[language.lowercased()] else { return nil }
    return highlighter.tokens(lines: lines, language: grammar).map { line in
      line.map { MarkdownToken(columns: $0.columns, kind: Self.kinds[$0.kind] ?? .punctuation) }
    }
  }
  var mathPreamble: String { "" }
}

/// the second card's sample: a few blocks to move between the Notes
let secondSample = """
  ## Second Note

  A paragraph to move into the other Note, or to take blocks from it with ⌘.

  - one
  - two

  ```python
  print("moved")
  ```
  """

let sample = """
  # Native Markdown

  The scheduler takes **one step** of the batch: it picks the sequences that fit, runs the model once and appends a
  token to each. *Prefill* handles a whole prompt at once; `decode` adds one token a step. See [the docs](https://example.com).

  调度器把请求分成批次，每个批次在显存里保留==键值缓存==，然后计算注意力 $\\operatorname{softmax}(QK^\\top / \\sqrt{d})V$。

  - prefill first
    - then **decode**
  - [x] blocks freed
  - [ ] swap back

  > A quote with a [[reference]] and an :tada: emoji.

  | Stage | What it does | ms |
  |:---|---|--:|
  | prefill | 一次处理整段提示 | 12.5 |
  | decode | one token a step | 0.8 |

  ```python
  def step(self, batch):
      return self.model(batch.ids)
  ```

  $$
  \\sum_{k=1}^{n} k^2 = \\frac{n(n+1)(2n+1)}{6}
  $$

  ![A made-up picture](picture.png "图 1：a caption under the picture")

  ```mermaid
  flowchart LR
    A[请求] --> B{有空闲块?}
    B -->|是| C[Prefill]
    B -->|否| D[等待]
  ```

  ---

  Last line.
  """

/// The sample's folder: a picture drawn here, in a temporary folder of this process's own
func sampleFolder() -> URL {
  let folder = FileManager.default.temporaryDirectory.appending(path: "markdown-demo-\(getpid())")
  try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  let (w, h) = (1200, 675)
  let ctx = CGContext(
    data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.setFillColor(CGColor(srgbRed: 0.85, green: 0.62, blue: 0.45, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.setFillColor(CGColor(srgbRed: 0.98, green: 0.95, blue: 0.9, alpha: 0.7))
  ctx.fillEllipse(in: CGRect(x: 380, y: 120, width: 440, height: 440))
  if let dest = CGImageDestinationCreateWithURL(
    folder.appending(path: "picture.png") as CFURL, "public.png" as CFString, 1, nil)
  {
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    CGImageDestinationFinalize(dest)
  }
  return folder
}

@MainActor
final class Demo: NSObject, NSApplicationDelegate, MarkdownEditorDelegate {
  var text: String
  var folder: URL
  let cardWidth: Double
  var resources: FileResources
  var look = "warm-ink"
  var name = "Markdown"
  var dark = false
  var zoom: CGFloat = 1
  var window: NSWindow!
  let scroll = NSScrollView()
  /// the Notes at the left, the inspector as a fixed column at the right
  let columns = Columns()
  /// the panel at the right: selection, copied, events (on by default)
  let inspector = Inspector()
  let page = Page()
  /// the cards, top to bottom: each a Note's editor (its picture until clicked)
  var cards: [MarkdownEditorView] = []
  /// a second Note's text (--second, or View > Second Note)
  var secondText: String?
  /// the first card: what the report names and the inspector watches first
  var editor: MarkdownEditorView? { cards.first }
  /// the ⌘ gesture's host (BlockMoveHost)
  lazy var moves = BlockMoveHost(demo: self)
  var zoomLabel: NSTextField!
  var images: [String: CGImage] = [:]
  /// code colours that never hold a key up (the component's LiveHighlight), one per folder images resolve against
  private var lives: [URL: LiveHighlight] = [:]
  func live(for folder: URL) -> LiveHighlight {
    if let l = lives[folder] { return l }
    let l = LiveHighlight(FileResources(folder: folder, pasted: resources.pasted, math: resources.math))
    lives[folder] = l
    return l
  }
  /// an opened vault (File > Open Vault…), read and never written, and the board shown from it: its Notes stacked in one
  /// column, in reading order (VaultNotes)
  var vault: Vault?
  var boardPath: String?
  var vaultNotes: [VaultNote]?
  /// the Board menu, filled from the vault's folders, and the toolbar's picker of the same boards
  let boardMenu = NSMenu(title: "Board")
  let boardPicker = NSPopUpButton(frame: CGRect(x: 0, y: 0, width: 220, height: 24), pullsDown: false)

  @objc func pickFromToolbar(_ p: NSPopUpButton) {
    guard let path = p.selectedItem?.representedObject as? String, path != boardPath, show(board: path) else { return }
    remember()
  }

  /// the paper under the card, the card's box and the editor inside it; a click on the paper ends editing
  final class Page: NSView {
    var onClick: () -> Void = {}
    /// a file, board or vault dropped on the paper
    var onDrop: (URL) -> Bool = { _ in false }
    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
      sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
        ? .copy : []
    }
    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
      guard
        let url = sender.draggingPasteboard.readObjects(
          forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])?.first as? URL
      else { return false }
      return onDrop(url)
    }
    /// a card's right edge pressed (0), dragged (1), let go (2): true when the press was on one
    var onEdge: (Int, CGPoint) -> Bool = { _, _ in false }
    var isEdge: (CGPoint) -> Bool = { _ in false }
    private var edging = false
    override func mouseDown(with event: NSEvent) {
      edging = onEdge(0, convert(event.locationInWindow, from: nil))
      if !edging { onClick() }
    }
    override func mouseDragged(with event: NSEvent) {
      if edging { _ = onEdge(1, convert(event.locationInWindow, from: nil)) }
    }
    override func mouseUp(with event: NSEvent) {
      if edging { _ = onEdge(2, convert(event.locationInWindow, from: nil)) }
      edging = false
    }
    /// the resize pointer over each card's right edge
    override func resetCursorRects() {
      for r in cardRects {
        addCursorRect(CGRect(x: r.maxX - 6, y: r.minY, width: 10, height: r.height), cursor: .resizeLeftRight)
      }
    }
    var paper = NSColor.windowBackgroundColor
    var card = NSColor.textBackgroundColor
    /// each card's fill (nil: none, a Text on the paper)
    var fills: [NSColor?] = []
    var cardRects: [CGRect] = []
    var cardRect: CGRect { cardRects.first ?? .zero }
    /// how many times the paper has drawn (the HUD)
    var draws = 0
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
      draws += 1
      paper.setFill()
      dirtyRect.fill()
      for (i, r) in cardRects.enumerated() {
        guard let fill = i < fills.count ? fills[i] : card else { continue }
        fill.setFill()
        NSBezierPath(roundedRect: r, xRadius: 10, yRadius: 10).fill()
      }
    }
  }

  init(text: String, folder: URL, cardWidth: Double) throws {
    // in a test process: its alerts and open panels never come up (an editor puts the same guard in)
    TestGuard.install()
    self.text = text
    self.folder = folder
    self.cardWidth = cardWidth
    try MarkdownAssets.fonts.get()
    resources = FileResources(folder: folder, pasted: Pasted(), math: try MarkdownAssets.engines())
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    // warm up off the main thread, as a host does at launch
    let math = resources.math
    DispatchQueue.global(qos: .userInitiated).async {
      MarkdownAssets.warmUp(math: math)
      // the first display ran beside the warm-up and may have made a second engine: once quiet, one is enough
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) { (math as? JSEngines)?.trim() }
    }
    setUp()
    if restoresVault, let path = DemoDefaults.vault, FileManager.default.fileExists(atPath: path) {
      open(vault: URL(filePath: path), board: DemoDefaults.board)
    }
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }

  /// the window and everything in it, laid out, not shown (`--check` renders it offscreen)
  func setUp() {
    if window == nil {
      window = NSWindow(
        contentRect: CGRect(x: 0, y: 0, width: cardWidth + 160 + 340, height: 820),
        styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
    }
    setTitle()
    scroll.hasVerticalScroller = true
    scroll.hasHorizontalScroller = true
    scroll.documentView = page
    columns.notes = scroll
    columns.panel = inspector
    columns.noteWidth = { [weak self] in
      guard let self else { return 0 }
      return CGFloat(self.sheets.map(\.width).max() ?? self.cardWidth) * self.zoom + 2 * 40
    }
    columns.onResize = { [weak self] in self?.place() }
    inspector.context = { [weak self] in
      guard let self, let w = self.window else { return "" }
      let size = w.contentView?.bounds.size ?? .zero
      let what = self.vault != nil ? "a board, \(self.cards.count) cards" : "a file, \(self.cards.count) cards"
      return
        "window \(Int(size.width)) × \(Int(size.height)) pt at \(w.backingScaleFactor)x, zoom \(Int(self.zoom * 100)) %, "
        + "\(self.look), \(self.dark ? "dark" : "light"), \(what)" + (self.widthLine.map { ", " + $0 } ?? "")
    }
    inspector.extra = { [weak self] in self?.widthLine }
    inspector.counts = { [weak self] in
      guard let self else { return (0, 0, 0) }
      return (self.cards.reduce(0) { $0 + $1.draws }, self.page.draws, MarkdownEditorView.linkTicks)
    }
    page.onClick = { [weak self] in for c in self?.cards ?? [] { c.isEditing = false } }
    page.onEdge = { [weak self] phase, p in
      guard let self else { return false }
      switch phase {
      case 0: return self.edgeDown(p)
      case 1: self.edgeDragged(p)
      default: self.edgeUp()
      }
      return true
    }
    page.isEdge = { [weak self] p in self?.edgeCard(at: p) != nil }
    page.registerForDraggedTypes([.fileURL])
    page.onDrop = { [weak self] url in
      guard let self, self.open(any: url) else { return false }
      self.remember()
      return true
    }
    moves.start()
    window.contentView = columns
    window.toolbar = toolbar()
    menu()
    rebuild()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

  /// a file, board or vault dropped on the app's icon or opened from Finder
  func application(_ app: NSApplication, openFile path: String) -> Bool {
    let ok = open(any: URL(filePath: path))
    if ok { remember() }
    return ok
  }

  /// What Open takes: a Markdown file, a board package (`X.board`, in its vault: the nearest folder above holding the
  /// app's data folder, else the folder it is in) or a vault folder
  @discardableResult
  func open(any url: URL) -> Bool {
    guard url.hasDirectoryPath || (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else {
      return open(url)
    }
    guard url.pathExtension == Vault.packageExtension else { return open(vault: url, board: nil) }
    var root = url.deletingLastPathComponent()
    var probe = root
    while probe.pathComponents.count > 1 {
      if FileManager.default.fileExists(atPath: probe.appending(path: Vault.appDataFolder).path) {
        root = probe
        break
      }
      probe = probe.deletingLastPathComponent()
    }
    let board = String(url.standardizedFileURL.path.dropFirst(root.standardizedFileURL.path.count + 1))
    return open(vault: root, board: board.hasSuffix("/") ? String(board.dropLast()) : board)
  }

  @discardableResult
  func open(_ url: URL) -> Bool {
    guard let t = try? String(contentsOf: url, encoding: .utf8) else { return false }
    vault = nil
    fillBoardMenu(nil)
    text = t
    folder = url.deletingLastPathComponent()
    resources = FileResources(folder: folder, pasted: resources.pasted, math: resources.math)
    vaultNotes = nil
    boardPath = nil
    clearCards()
    window?.isDocumentEdited = false
    name = url.lastPathComponent
    setTitle()
    if window != nil { rebuild() }
    return true
  }

  /// every card goes: the next rebuild makes new editors for new texts
  func clearCards() {
    images = [:]
    widths = [:]
    dragStats = nil
    for c in cards { c.removeFromSuperview() }
    cards = []
  }

  @objc func openVault(_ s: Any?) {
    let p = NSOpenPanel()
    p.canChooseDirectories = true
    p.canChooseFiles = false
    p.message = "A vault folder: its boards are read, never written"
    guard p.runModal() == .OK, let url = p.url, open(vault: url, board: nil) else { return }
    remember()
  }

  /// window title: the file's name, or the vault and board; a board's edits stay in memory and say so
  func setTitle() {
    var t = name
    if vault != nil, boardPath != nil { t += " — not saved" }
    window?.title = t
  }

  /// what a person picked from the menus is what the next plain launch opens
  func remember() {
    DemoDefaults.vault = vault?.root.path
    DemoDefaults.board = boardPath
  }

  /// Opens a vault and a board in it (nil: its first board)
  @discardableResult
  func open(vault url: URL, board: String?) -> Bool {
    let v = Vault(root: url)
    guard let tree = try? v.tree() else {
      alert("Not a vault", "\(url.path) could not be read as a vault.")
      return false
    }
    vault = v
    fillBoardMenu(tree)
    let boards = tree.allBoards
    guard let path = board.flatMap({ b in boards.first { $0.path == b }?.path }) ?? boards.first?.path else {
      vaultNotes = []
      boardPath = nil
      window?.title = url.lastPathComponent
      clearCards()
      if window != nil { rebuild() }
      return true
    }
    return show(board: path)
  }

  /// the board's Notes, stacked; a board that does not read says why
  @discardableResult
  func show(board path: String) -> Bool {
    guard let v = vault else { return false }
    do {
      let (notes, skipped) = try VaultNotes.notes(of: path, in: v)
      vaultNotes = notes
      boardPath = path
      let title = path.split(separator: "/").last.map { String($0.dropLast(".board".count)) } ?? path
      name = "\(v.root.lastPathComponent) – \(title)"
      setTitle()
      window?.isDocumentEdited = false
      markBoard(path)
      clearCards()
      if window != nil { rebuild() }
      if !skipped.isEmpty { alert("Some cards were left out", skipped.joined(separator: "\n")) }
      return true
    } catch {
      alert("The board could not be read", "\(error)")
      return false
    }
  }

  @objc func pickBoard(_ item: NSMenuItem) {
    guard let path = item.representedObject as? String, show(board: path) else { return }
    remember()
  }

  /// the board shown, ticked in the menu and chosen in the toolbar's picker
  func markBoard(_ path: String?) {
    func mark(_ m: NSMenu) {
      for item in m.items {
        item.state = item.representedObject as? String == path ? .on : .off
        if let sub = item.submenu { mark(sub) }
      }
    }
    mark(boardMenu)
    if let i = boardPicker.itemArray.firstIndex(where: { $0.representedObject as? String == path }) {
      boardPicker.selectItem(at: i)
    }
  }

  /// one item per board, a submenu per folder, in the vault's own order (nil: no vault); the toolbar's picker lists the
  /// same boards, folders as a path before the title
  func fillBoardMenu(_ tree: VaultFolder?) {
    boardPicker.removeAllItems()
    boardPicker.isEnabled = tree != nil
    guard let tree else {
      boardMenu.removeAllItems()
      boardMenu.addItem(withTitle: "Open a vault or a board first", action: nil, keyEquivalent: "")
      boardPicker.addItem(withTitle: "No board")
      return
    }
    func pick(_ folder: VaultFolder, _ prefix: String) {
      for b in folder.boards {
        boardPicker.addItem(withTitle: prefix + b.title)
        boardPicker.lastItem?.representedObject = b.path
      }
      for f in folder.folders { pick(f, prefix + f.name + " / ") }
    }
    pick(tree, "")
    func fill(_ menu: NSMenu, _ folder: VaultFolder) {
      for f in folder.folders {
        let sub = NSMenu(title: f.name)
        fill(sub, f)
        menu.addItem(withTitle: f.name, action: nil, keyEquivalent: "").submenu = sub
      }
      for b in folder.boards {
        let item = menu.addItem(withTitle: b.title, action: #selector(pickBoard(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = b.path
      }
    }
    boardMenu.removeAllItems()
    fill(boardMenu, tree)
    if boardPicker.numberOfItems == 0 { boardPicker.addItem(withTitle: "No boards") }
    if boardMenu.items.isEmpty {
      boardMenu.addItem(withTitle: "No boards in this vault", action: nil, keyEquivalent: "")
    }
  }

  func alert(_ title: String, _ text: String) {
    guard window != nil, NSApp.isRunning else { return }
    let a = NSAlert()
    a.messageText = title
    a.informativeText = text
    a.runModal()
  }

  @objc func openDocument(_ s: Any?) {
    let p = NSOpenPanel()
    p.allowedContentTypes = [.init(filenameExtension: "md")!, .plainText, .folder]
    p.canChooseDirectories = true
    p.treatsFilePackagesAsDirectories = false
    p.message = "A Markdown file, a board (.board) or a vault folder. A board is read, never written"
    guard p.runModal() == .OK, let url = p.url, open(any: url) else { return }
    remember()
  }

  /// What the cards show: a vault's board (its Markdown cards, each with its own image folder, layout info, style and
  /// width), else the file and a second Note, as Notes of the demo's width
  var sheets: [VaultNote] {
    let notes =
      vaultNotes
      ?? ([text] + (secondText.map { [$0] } ?? [])).enumerated().map {
        VaultNote(id: "\($0.offset)", text: $0.element, folder: folder, width: cardWidth)
      }
    // widths changed here (the toolbar's for all, a card's edge for one), never written back
    return notes.enumerated().map { i, n in
      var n = n
      n.width = widths[i] ?? allWidth ?? n.width
      return n
    }
  }

  // MARK: card widths

  /// a card's width set by dragging its edge, and the toolbar's width for every card; reset with the board
  var widths: [Int: Double] = [:]
  var allWidth: Double?
  static let widthRange = 240.0...1600.0
  /// the edge drag under way: the card, its width and the pointer's x at the press
  private var widthDrag: (card: Int, from: Double, x: CGFloat)?
  /// the last drag's per-frame relayout (ms, last and worst) and frames over a display frame's time
  private(set) var dragStats: (last: Double, worst: Double, frames: Int, dropped: Int)?

  /// card `i` laid out again at `width`: only it, every frame of a drag (no picture stretched)
  func setWidth(_ width: Double, of i: Int) {
    guard cards.indices.contains(i) else { return }
    let t0 = ProcessInfo.processInfo.systemUptime
    widths[i] = min(Self.widthRange.upperBound, max(Self.widthRange.lowerBound, width))
    let n = sheets[i]
    let card = Self.card(n.style, look: look, dark: dark)
    let e = cards[i]
    let layout = BlockLayout(
      e.core.document, width: n.width - card.padding[1] - card.padding[3], theme: card.theme,
      layout: e.core.layout.info,
      resources: live(for: n.folder))
    e.core.relayout(layout)
    e.setFrameSize(CGSize(width: ceil(layout.size.width * zoom), height: ceil(layout.size.height * zoom)))
    e.needsDisplay = true
    place()
    e.displayIfNeeded()
    let ms = (ProcessInfo.processInfo.systemUptime - t0) * 1000
    let s = dragStats ?? (0, 0, 0, 0)
    dragStats = (ms, max(s.worst, ms), s.frames + 1, s.dropped + (ms > 1000.0 / 60 ? 1 : 0))
  }

  /// the toolbar's width: every card at once
  @objc func setAllWidths(_ s: NSSlider) {
    allWidth = s.doubleValue
    widths = [:]
    dragStats = nil
    rebuild()
  }

  /// a press on a card's right edge (its last 6 points and 4 past it)
  func edgeCard(at p: CGPoint) -> Int? {
    page.cardRects.indices.first { i in
      let r = page.cardRects[i]
      return p.y >= r.minY && p.y <= r.maxY && p.x >= r.maxX - 6 && p.x <= r.maxX + 4
    }
  }

  func edgeDown(_ p: CGPoint) -> Bool {
    guard let i = edgeCard(at: p) else { return false }
    widthDrag = (i, sheets[i].width, p.x)
    dragStats = nil
    return true
  }

  func edgeDragged(_ p: CGPoint) {
    guard let d = widthDrag else { return }
    // both edges move: the cards stand centred in the column
    setWidth(d.from + Double(2 * (p.x - d.x) / zoom), of: d.card)
  }

  func edgeUp() { widthDrag = nil }

  /// the last width drag's numbers, for the HUD and the report
  var widthLine: String? {
    dragStats.map {
      String(
        format: "width drag: relayout last %.1f ms, worst %.1f ms, %d frames, %d dropped", $0.last, $0.worst,
        $0.frames, $0.dropped)
    }
  }

  /// A style's card as the demo draws it: without the header strip a board draws over a Note (its title bar), which the
  /// demo has none of, so no blank band is left at a card's top
  static func card(_ style: MarkdownLooks.Style, look: String, dark: Bool) -> MarkdownLooks.Card {
    var c = MarkdownLooks.card(style, look: look, dark: dark)
    c.header = 0
    return c
  }

  /// card `i`'s look: its style in the look and appearance
  func card(_ i: Int) -> MarkdownLooks.Card {
    Self.card(sheets[safe: i]?.style ?? .note, look: look, dark: dark)
  }

  /// Lays the texts out in the look and appearance: the editors kept (selection and undo history), only their layouts new
  func rebuild() {
    let notes = sheets
    while cards.count > notes.count { cards.removeLast().removeFromSuperview() }
    for (i, n) in notes.enumerated() {
      let card = Self.card(n.style, look: look, dark: dark)
      let inner = n.width - card.padding[1] - card.padding[3]
      let doc = i < cards.count ? cards[i].core.document : MarkdownDocument(n.text)
      let info = i < cards.count ? cards[i].core.layout.info : n.info
      let layout = BlockLayout(doc, width: inner, theme: card.theme, layout: info, resources: live(for: n.folder))
      let e: MarkdownEditorView
      if i < cards.count {
        e = cards[i]
        e.core.relayout(layout)
      } else {
        e = MarkdownEditorView(layout: layout, caret: 0)
        // a card shows its picture until it is clicked, as on the board
        e.isEditing = false
        e.delegate = self
        // the other half of a move across Notes goes back (or comes again) with this one
        e.core.onLinkedStep = { [weak self] link, undo in
          guard let self else { return false }
          for c in self.cards where c !== e {
            if undo ? c.core.undoLinked(link) : c.core.redoLinked(link) {
              c.coreChanged()
              self.editor(c, didChange: c.core.source)
              return true
            }
          }
          return false
        }
        let folder = n.folder
        e.image = { [weak self] slot in self?.image(slot, in: folder) }
        e.codeLanguages = [
          ("python", "Python"), ("rust", "Rust"), ("c", "C"), ("cpp", "C++"), ("cuda", "CUDA"), ("triton", "Triton"),
          ("tilelang", "TileLang"), ("mermaid", "Mermaid"), ("json", "JSON"), ("bash", "Shell"),
        ]
        cards.append(e)
        page.addSubview(e)
        if i == 0 { inspector.watch(e) }
      }
      let ink = card.theme.colors
      e.caretColor = NSColor(cgColor: ink.accent.cg) ?? .controlAccentColor
      e.selectionColor = NSColor(cgColor: ink.accent.alpha(0.26).cg) ?? .selectedTextBackgroundColor
      e.needsDisplay = true
    }
    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    page.paper = NSColor(cgColor: MarkdownLooks.theme(look, dark: dark).colors.surface.cg)!.blended(
      withFraction: 0.06, of: dark ? .black : .gray)!
    let surface = MarkdownLooks.theme(look, dark: dark).colors.surface.cg
    page.card = NSColor(cgColor: surface)!
    // a Note on its card, a Box on its fill, a Text on the paper
    page.fills = notes.map { n in
      switch n.style {
      case .note: page.card
      case .text: nil
      case .box: n.fill.map { Self.boxFill($0, surface: surface) } ?? page.card
      }
    }
    place()
    if let e = cards.first { window.makeFirstResponder(e) }
  }

  /// The cards at the zoom, one under another, centred, each editor at its card's padding. `animated` (after a ⌘ move):
  /// each card's bottom edge, and the cards under it, slide from where they were over FLIP_MS (blockmove.ts's height
  /// change) instead of jumping, from the boxes `before` the move changed the Notes
  func place(animatedFrom before: [CGRect]? = nil) {
    let margin: CGFloat = 40
    let gap: CGFloat = 24
    var sizes: [CGSize] = []
    let notes = sheets
    for (i, e) in cards.enumerated() {
      e.zoom = zoom
      sizes.append(card(i).size(content: e.core.layout.size, width: notes[safe: i]?.width ?? cardWidth, height: nil))
    }
    let widest = sizes.map(\.width).max() ?? CGFloat(cardWidth)
    let w = max(scroll.contentSize.width, widest * zoom + 2 * margin)
    var y = margin
    var rects: [CGRect] = []
    for size in sizes {
      let x = (w - size.width * zoom) / 2
      rects.append(CGRect(x: x, y: y, width: size.width * zoom, height: size.height * zoom))
      y = rects[rects.count - 1].maxY + gap
    }
    if let from = before, from.count == rects.count, from != rects, window?.occlusionState.contains(.visible) == true {
      grow = (from, rects, CACurrentMediaTime())
      if growLink == nil {
        let link = page.displayLink(target: self, selector: #selector(growFrame(_:)))
        link.add(to: .main, forMode: .common)
        growLink = link
      }
      show(rects: from, width: w)
    } else {
      grow = nil
      growLink?.invalidate()
      growLink = nil
      show(rects: rects, width: w)
    }
    moves.layoutChanged()
    DispatchQueue.main.async { [weak self] in self?.writeReport() }
    zoomLabel?.stringValue = "\(Int((zoom * 100).rounded())) %"
  }

  /// a height change sliding: the cards' boxes before and after, since when
  private var grow: (from: [CGRect], to: [CGRect], since: CFTimeInterval)?
  private var growLink: CADisplayLink?

  @objc private func growFrame(_ link: CADisplayLink) {
    MarkdownEditorView.linkTicks += 1
    guard let g = grow else { return }
    let e = CGFloat(MarkdownTiming.ease((link.targetTimestamp - g.since) / MarkdownTiming.blockFlip))
    let rects = zip(g.from, g.to).map { a, b in
      CGRect(x: b.minX, y: a.minY + (b.minY - a.minY) * e, width: b.width, height: a.height + (b.height - a.height) * e)
    }
    show(rects: rects, width: page.frame.width)
    if e >= 1 {
      grow = nil
      growLink?.invalidate()
      growLink = nil
    }
  }

  /// where an editor is once a height change in flight has settled (page points)
  func settledOrigin(of e: MarkdownEditorView) -> CGPoint {
    guard let g = grow, let i = cards.firstIndex(where: { $0 === e }), i < g.to.count else { return e.frame.origin }
    let card = card(i)
    return CGPoint(
      x: g.to[i].minX + card.padding[3] * zoom, y: g.to[i].minY + (card.header + card.padding[0]) * zoom)
  }

  /// the page's size, the cards' boxes and each editor at its card's top
  private func show(rects: [CGRect], width w: CGFloat) {
    let bottom = max(rects.last?.maxY ?? 0, grow?.to.last?.maxY ?? 0)
    page.frame = CGRect(x: 0, y: 0, width: w, height: bottom + 40)
    page.cardRects = rects
    page.window?.invalidateCursorRects(for: page)
    for (i, (e, r)) in zip(cards, rects).enumerated() {
      let card = card(i)
      e.setFrameOrigin(CGPoint(x: r.minX + card.padding[3] * zoom, y: r.minY + (card.header + card.padding[0]) * zoom))
    }
    page.needsDisplay = true
  }

  /// a Box's fill: the colour mixed into the paper, as the canvas mixes it (CodeBoardCanvas Theme.boxFills)
  static func boxFill(_ f: BoxFill, surface: CGColor) -> NSColor {
    let (p, other): (CGFloat, UInt32) =
      switch f {
      case .yellow: (0.66, 0xf0cf62)
      case .paper: (1, 0)
      case .blue: (0.78, 0x8eb0dc)
      case .green: (0.76, 0x9cc48a)
      case .pink: (0.78, 0xe3a0b4)
      }
    let s = NSColor(cgColor: surface)?.usingColorSpace(.sRGB) ?? .white
    let o = [16, 8, 0].map { CGFloat(other >> UInt32($0) & 0xff) / 255 }
    return NSColor(
      srgbRed: s.redComponent * p + o[0] * (1 - p), green: s.greenComponent * p + o[1] * (1 - p),
      blue: s.blueComponent * p + o[2] * (1 - p), alpha: 1)
  }

  @objc func toggleSecond(_ s: Any?) {
    guard vaultNotes == nil else { return }
    secondText = secondText == nil ? secondSample : nil
    rebuild()
  }

  func image(_ slot: MarkdownImageSlot, in folder: URL) -> CGImage? {
    let url = folder.appending(path: slot.src)
    if let i = images[url.path] ?? resources.pasted.picture(slot.src) { return i }
    // an SVG drawn at twice its box's width at the zoom (sharp on the display; again when the zoom grows past it)
    if !slot.src.contains("://"), let d = try? Data(contentsOf: url), MarkdownSVG.isSVG(d) {
      let want = slot.pixelWidth(at: 2 * max(1, zoom))
      // one drawing per file and look, drawn again only when a wider one is wanted: a picture being resized is that
      // one drawing scaled into its box every frame, never a new drawing a step (drawings swapped in mid-drag flickered)
      let key = url.path + (dark ? "@dark" : "@light")
      if let i = images[key] {
        // wider wanted: drawn again off the main thread, the one it has scaled meanwhile (a heavy figure drawn at every
        // step of a width drag stalled it); one drawing at a time per picture, the widest asked for when it is done
        if i.width < want { drawLater(d, key: key, width: want * 3 / 2, dark: dark) }
        return i
      }
      let i = MarkdownSVG.image(d, pixelWidth: want, dark: dark)
      images[key] = i
      svgDraws.sync += 1
      return i
    }
    guard !slot.src.contains("://"), let s = CGImageSourceCreateWithURL(url as CFURL, nil),
      let i = CGImageSourceCreateImageAtIndex(s, max(0, (slot.stillFrame ?? 1) - 1), nil)
    else { return nil }
    images[url.path] = i
    return i
  }

  /// SVG drawings made on the main thread (a picture's first) and off it (a wider one), for the check and tests
  var svgDraws = (sync: 0, background: 0)
  /// a wider drawing under way per picture, and the widest asked for since it started
  private var drawing: [String: Int] = [:]

  private func drawLater(_ d: Data, key: String, width: Int, dark: Bool) {
    if let w = drawing[key] {
      drawing[key] = max(w, width)
      return
    }
    drawing[key] = width
    svgDraws.background += 1
    DispatchQueue.global(qos: .userInitiated).async {
      let i = MarkdownSVG.image(d, pixelWidth: width, dark: dark)
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        let wanted = self.drawing.removeValue(forKey: key) ?? width
        if let i, i.width > self.images[key]?.width ?? 0 {
          self.images[key] = i
          for c in self.cards { c.needsDisplay = true }
        }
        if wanted > width { self.drawLater(d, key: key, width: wanted, dark: dark) }
      }
    }
  }

  func editor(_ e: MarkdownEditorView, didResize size: CGSize) { place() }
  func editor(_ e: MarkdownEditorView, didChange source: String) {
    window.isDocumentEdited = true
    // for a driver reading the Notes back: the first Note's Markdown after every change, a second Note's beside it
    guard let saveTo else { return }
    if e === cards.first {
      try? source.write(to: saveTo, atomically: true, encoding: .utf8)
    } else if let i = cards.firstIndex(where: { $0 === e }) {
      let other = saveTo.deletingPathExtension().appendingPathExtension("\(i + 1).md")
      try? source.write(to: other, atomically: true, encoding: .utf8)
    }
  }

  /// a plain launch (no file, no driver's options) opens the vault and board it had open last
  var restoresVault = false

  /// where the demo writes the Note's Markdown after every change, and where it reports the card's place
  var saveTo: URL?
  var reportTo: URL?

  /// the card's and the editor's frames in the window (points from the top left), the zoom and the window's number
  func writeReport() {
    guard let reportTo, let e = editor, let content = window.contentView else { return }
    func top(_ r: CGRect) -> [Double] {
      let w = content.convert(r, from: page)
      // from the window content's top, whichever way the content view counts
      let y = content.isFlipped ? w.minY : content.bounds.height - w.maxY
      return [w.minX, y, w.width, w.height].map { Double($0) }
    }
    let out: [String: Any] = [
      "window": window.windowNumber, "zoom": Double(zoom), "card": top(page.cardRect), "editor": top(e.frame),
      "editing": e.isEditing,
      // every card, top to bottom (the first is the one above)
      "cards": zip(cards, page.cardRects).map { c, r in
        ["card": top(r), "editor": top(c.frame), "editing": c.isEditing]
      },
    ]
    if let data = try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]) {
      try? data.write(to: reportTo)
    }
  }
  @objc func toggleInspector(_ c: NSSegmentedControl) {
    columns.wantsPanel = c.isSelected(forSegment: 0)
  }
  func editorWantsToEnd(_ e: MarkdownEditorView) { e.isEditing = false }
  func editorDidBegin(_ e: MarkdownEditorView) {
    // one card edits at a time
    for c in cards where c !== e { c.isEditing = false }
    inspector.watch(e)
  }
  func editor(_ e: MarkdownEditorView, open url: URL) { NSWorkspace.shared.open(url) }

  /// references picked from the [[ menu, newest first (in memory)
  private var recentRefs: [MarkdownRefCandidate] = []

  /// The [[ menu from the open vault: this board's other cards, then each other board with its cards, by their first
  /// line; what is typed narrows them
  func editor(_ e: MarkdownEditorView, refMenu query: String) -> MarkdownRefMenu {
    let q = query.lowercased()
    guard let v = vault, let tree = try? v.tree() else {
      let local = FileResources.sampleCards.filter { q.isEmpty || $0.lowercased().contains(q) }
        .map { MarkdownRefCandidate(label: $0, target: nil, title: $0) }
      return MarkdownRefMenu(recent: recentRefs, here: "This board", local: local)
    }
    func title(_ n: VaultNote) -> String {
      let first = n.title ?? n.text.split(separator: "\n").first.map(String.init) ?? ""
      // its first line as read: heading marks and inline markers left out
      return first.replacingOccurrences(of: #"^#+\s*"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"[*_`~=]{1,2}"#, with: "", options: .regularExpression)
    }
    func fits(_ t: String) -> Bool { q.isEmpty || t.lowercased().contains(q) }
    let mine = (vaultNotes ?? []).enumerated().filter { cards.indices.contains($0.offset) && cards[$0.offset] !== e }
      .map { MarkdownRefCandidate(label: title($0.element), target: $0.element.id, title: title($0.element)) }
      .filter { fits($0.title) }
    var groups: [MarkdownRefGroup] = []
    for b in tree.allBoards where b.path != boardPath {
      let notes = (try? VaultNotes.notes(of: b.path, in: v).notes) ?? []
      let items = notes.map { MarkdownRefCandidate(label: title($0), target: $0.id, title: title($0), crumb: b.title) }
        .filter { fits($0.title) }
      guard !items.isEmpty || fits(b.title) else { continue }
      groups.append(
        MarkdownRefGroup(
          id: b.path, title: b.title, place: MarkdownRefCandidate(label: b.title, target: nil, title: b.title),
          note: notes.count == 1 ? "1 card" : "\(notes.count) cards", items: items))
    }
    return MarkdownRefMenu(recent: recentRefs, here: "This board", local: mine, groups: groups)
  }

  /// `--pick-image <file>`: the file / Image takes, without the Open panel (a driver's run never puts a modal panel on
  /// the screen); nil asks with the panel
  var pickImage: URL?
  func editorPicksImage(_ e: MarkdownEditorView) -> (Data, String)? {
    guard let u = pickImage else { return DefaultPicker().editorPicksImage(e) }
    return (try? Data(contentsOf: u)).map { ($0, u.lastPathComponent) }
  }

  /// a click on a resolved reference: taken (a board would go to the card); the editor logs it in the inspector
  func editor(_ e: MarkdownEditorView, activate label: String, target: String?) -> Bool { true }

  func editor(_ e: MarkdownEditorView, pickedRef r: MarkdownRefCandidate) {
    recentRefs.removeAll { $0 == r }
    recentRefs.insert(r, at: 0)
  }
  func editor(_ e: MarkdownEditorView, saveImage data: Data, name: String) -> String? { resources.pasted.add(data) }

  // MARK: controls

  @objc func setLook(_ c: NSSegmentedControl) {
    look = c.selectedSegment == 0 ? "warm-ink" : "ink-wash"
    rebuild()
  }
  @objc func setDark(_ c: NSSegmentedControl) {
    dark = c.selectedSegment == 1
    rebuild()
  }
  @objc func setZoom(_ s: NSSlider) {
    zoom = CGFloat(s.doubleValue) / 100
    place()
  }
  @objc func zoomIn(_ s: Any?) { step(1.25) }
  @objc func zoomOut(_ s: Any?) { step(0.8) }
  @objc func zoomActual(_ s: Any?) {
    zoom = 1
    place()
  }
  func step(_ k: CGFloat) {
    zoom = min(2, max(0.5, zoom * k))
    place()
  }

  func toolbar() -> NSToolbar {
    let t = NSToolbar(identifier: "demo")
    t.delegate = self
    t.displayMode = .iconOnly
    return t
  }

  func menu() {
    let main = NSMenu()
    let app = NSMenuItem()
    app.submenu = NSMenu()
    app.submenu!.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    main.addItem(app)
    let file = NSMenuItem()
    file.submenu = NSMenu(title: "File")
    file.submenu!.addItem(withTitle: "Open…", action: #selector(openDocument(_:)), keyEquivalent: "o").target = self
    file.submenu!.addItem(withTitle: "Open Vault…", action: #selector(openVault(_:)), keyEquivalent: "O").target = self
    main.addItem(file)
    let edit = NSMenuItem()
    edit.submenu = NSMenu(title: "Edit")
    edit.submenu!.addItem(withTitle: "Undo", action: #selector(MarkdownEditorView.undo(_:)), keyEquivalent: "z")
    edit.submenu!.addItem(withTitle: "Redo", action: #selector(MarkdownEditorView.redo(_:)), keyEquivalent: "Z")
    edit.submenu!.addItem(.separator())
    edit.submenu!.addItem(withTitle: "Cut", action: #selector(MarkdownEditorView.cut(_:)), keyEquivalent: "x")
    edit.submenu!.addItem(withTitle: "Copy", action: #selector(MarkdownEditorView.copy(_:)), keyEquivalent: "c")
    edit.submenu!.addItem(withTitle: "Paste", action: #selector(MarkdownEditorView.paste(_:)), keyEquivalent: "v")
    edit.submenu!.addItem(withTitle: "Select All", action: #selector(NSResponder.selectAll(_:)), keyEquivalent: "a")
    main.addItem(edit)
    let view = NSMenuItem()
    view.submenu = NSMenu(title: "View")
    view.submenu!.addItem(withTitle: "Second Note", action: #selector(toggleSecond(_:)), keyEquivalent: "").target =
      self
    view.submenu!.addItem(.separator())
    // ⌥⌘: ⌘= ⌘- ⌘0 are the editor's heading keys
    for (title, action, key) in [
      ("Zoom In", #selector(zoomIn(_:)), "="), ("Zoom Out", #selector(zoomOut(_:)), "-"),
      ("Actual Size", #selector(zoomActual(_:)), "0"),
    ] {
      let item = view.submenu!.addItem(withTitle: title, action: action, keyEquivalent: key)
      item.keyEquivalentModifierMask = [.command, .option]
      item.target = self
    }
    main.addItem(view)
    let board = NSMenuItem()
    board.submenu = boardMenu
    if boardMenu.items.isEmpty { fillBoardMenu(vault.flatMap { try? $0.tree() }) }
    main.addItem(board)
    NSApp.mainMenu = main
  }
}

extension Demo: NSToolbarDelegate {
  static let items: [NSToolbarItem.Identifier] = [
    .init("inspector"), .init("board"), .init("look"), .init("dark"), .flexibleSpace, .init("width"), .init("zoom"),
  ]
  func toolbarDefaultItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { Self.items }
  func toolbarAllowedItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { Self.items }
  func toolbar(_ t: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar: Bool)
    -> NSToolbarItem?
  {
    let item = NSToolbarItem(itemIdentifier: id)
    switch id.rawValue {
    case "inspector":
      let c = NSSegmentedControl(
        labels: ["Inspector"], trackingMode: .selectAny, target: self, action: #selector(toggleInspector(_:)))
      c.setSelected(true, forSegment: 0)
      item.view = c
    case "board":
      boardPicker.target = self
      boardPicker.action = #selector(pickFromToolbar(_:))
      item.view = boardPicker
    case "look":
      let c = NSSegmentedControl(
        labels: ["Warm Ink", "Ink Wash"], trackingMode: .selectOne, target: self, action: #selector(setLook(_:)))
      c.selectedSegment = 0
      item.view = c
    case "dark":
      let c = NSSegmentedControl(
        labels: ["Light", "Dark"], trackingMode: .selectOne, target: self, action: #selector(setDark(_:)))
      c.selectedSegment = 0
      item.view = c
    case "width":
      let s = NSSlider(
        value: cardWidth, minValue: Self.widthRange.lowerBound, maxValue: Self.widthRange.upperBound, target: self,
        action: #selector(setAllWidths(_:)))
      s.frame.size.width = 140
      s.toolTip = "Card width"
      item.view = s
    case "zoom":
      let s = NSSlider(value: 100, minValue: 50, maxValue: 200, target: self, action: #selector(setZoom(_:)))
      s.frame.size.width = 160
      zoomLabel = NSTextField(labelWithString: "100 %")
      let stack = NSStackView(views: [s, zoomLabel])
      item.view = stack
    default: return nil
    }
    return item
  }
}

/// The window's content: the Notes' scroll view at the left and the inspector, a fixed column at the right of at most
/// `panelWidth` and a third of the window. The Notes keep the room their card needs (`noteWidth`): a window too narrow
/// for both collapses the panel, never the Notes
@MainActor
final class Columns: NSView {
  static let panelWidth: CGFloat = 300
  var notes: NSView? {
    didSet {
      oldValue?.removeFromSuperview()
      if let notes { addSubview(notes) }
    }
  }
  var panel: NSView? {
    didSet {
      oldValue?.removeFromSuperview()
      if let panel { addSubview(panel) }
    }
  }
  var noteWidth: () -> CGFloat = { 0 }
  var onResize: () -> Void = {}
  /// the toolbar's switch; the panel shows when this is on and the window has the room
  var wantsPanel = true {
    didSet { needsLayout = true }
  }
  /// the panel's width now (0: hidden or collapsed)
  var shownPanel: CGFloat {
    guard wantsPanel else { return 0 }
    let w = min(Self.panelWidth, (bounds.width / 3).rounded(.down))
    return bounds.width - w >= min(noteWidth(), bounds.width) && w >= 200 ? w : 0
  }

  override func layout() {
    super.layout()
    let w = shownPanel
    notes?.frame = CGRect(x: 0, y: 0, width: bounds.width - w, height: bounds.height)
    panel?.frame = CGRect(x: bounds.width - w, y: 0, width: w, height: bounds.height)
    if panel?.isHidden != (w == 0) { panel?.isHidden = w == 0 }
    onResize()
  }
}

/// Runs the demo window in this process (MarkdownDemo's main, and a driver that runs it in its own process):
///   [file.md] [--width 420] [--save-to <path>] [--report <path>] [--check <folder>] [--vault <folder> [--board <path>]]
///   [--pick-image <file>: what / Image takes, without the Open panel]
///   --make-sample-vault <folder> [--from <vault>]
/// --save-to writes the Note's Markdown there after every change; --report writes where the card and its editor are in the
/// window (points from its top left), the zoom and the window's number, whenever they move; --check (Check.run) lays the
/// window out without showing it, renders it offscreen at several widths, measures it at rest and exits; --vault opens a
/// vault (read only) at a board (its path in the vault; else the first), as File > Open Vault… does
@MainActor
public func runMarkdownDemo(arguments: [String]) throws -> Never {
  var args = arguments
  func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    let v = args[i + 1]
    args.removeSubrange(i...(i + 1))
    return v
  }
  let width = option("--width").flatMap(Double.init) ?? 420
  let second = option("--second").map { URL(filePath: $0) }
  let saveTo = option("--save-to").map { URL(filePath: $0) }
  let report = option("--report").map { URL(filePath: $0) }
  let check = option("--check").map { URL(filePath: $0) }
  let vault = option("--vault").map { URL(filePath: $0) }
  let board = option("--board")
  let pickImage = option("--pick-image").map { URL(filePath: $0) }
  if let folder = option("--make-sample-vault") {
    if let from = option("--from") {
      print(try DerivedVault.write(to: URL(filePath: folder), from: URL(filePath: from)).joined(separator: "\n"))
    } else {
      try SampleVault.write(to: URL(filePath: folder))
    }
    exit(0)
  }
  let file = args.first.map { URL(filePath: $0) }
  let text = try file.map { try String(contentsOf: $0, encoding: .utf8) } ?? sample
  let app = NSApplication.shared
  app.setActivationPolicy(.regular)
  // a window with unsaved edits in memory: the system must not end the process on its own while it rests
  ProcessInfo.processInfo.disableAutomaticTermination("Notes edited in memory")
  ProcessInfo.processInfo.disableSuddenTermination()
  let atStart = footprint()
  let demo = try Demo(text: text, folder: file?.deletingLastPathComponent() ?? sampleFolder(), cardWidth: width)
  demo.saveTo = saveTo
  demo.pickImage = pickImage
  if let second { demo.secondText = try String(contentsOf: second, encoding: .utf8) }
  demo.reportTo = report
  if let file { demo.name = file.lastPathComponent }
  demo.restoresVault = file == nil && vault == nil && second == nil && saveTo == nil && report == nil && check == nil
  if let vault { demo.open(vault: vault, board: board) }
  if let check { exit(Check.run(demo, out: check, start: atStart) ? 0 : 1) }
  app.delegate = demo
  app.run()
  exit(0)
}

/// What the demo remembers between launches, in its own defaults (its bundle's domain; never the app's)
@MainActor
enum DemoDefaults {
  static var vault: String? {
    get { UserDefaults.standard.string(forKey: "MarkdownDemo.vault") }
    set { UserDefaults.standard.set(newValue, forKey: "MarkdownDemo.vault") }
  }
  static var board: String? {
    get { UserDefaults.standard.string(forKey: "MarkdownDemo.board") }
    set { UserDefaults.standard.set(newValue, forKey: "MarkdownDemo.board") }
  }
}

extension Array {
  subscript(safe i: Int) -> Element? { i >= 0 && i < count ? self[i] : nil }
}

/// the component's own Open panel, for a demo not given --pick-image
private final class DefaultPicker: MarkdownEditorDelegate {
  func editor(_ e: MarkdownEditorView, didChange source: String) {}
  func editor(_ e: MarkdownEditorView, didResize size: CGSize) {}
  func editorWantsToEnd(_ e: MarkdownEditorView) {}
  func editorDidBegin(_ e: MarkdownEditorView) {}
}
