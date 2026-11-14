// A window to try the Markdown component in, standing alone (no canvas, no board): a Markdown file laid out as a Note
// card in the board's looks, with the editor over it. ⌘O opens another file; tools/markdown/make-demo.sh makes an app.
//   swift run MarkdownDemo [file.md] [--width 420]
// The card is a picture until clicked, as on the board: a click on it edits there, a click beside it or Esc ends editing.
// The toolbar switches the look (Warm Ink, Ink Wash), light and dark, and the zoom (50 to 200 %, also ⌥⌘= ⌥⌘- ⌥⌘0). Images
// are read relative to the file. Typing edits the text shown; the file is never written.
import AppKit
import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CodeBoardSyntax
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
    guard !src.contains("://"), let s = CGImageSourceCreateWithURL(folder.appending(path: src) as CFURL, nil),
      let p = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any],
      let w = p[kCGImagePropertyPixelWidth] as? Int, let h = p[kCGImagePropertyPixelHeight] as? Int
    else { return nil }
    return CGSize(width: w, height: h)
  }
  func ref(label: String, target: String?) -> MarkdownRefHit? { nil }
  func highlight(lines: [String], language: String) -> [[MarkdownToken]]? {
    guard let grammar = Self.grammars[language.lowercased()] else { return nil }
    return highlighter.tokens(lines: lines, language: grammar).map { line in
      line.map { MarkdownToken(columns: $0.columns, kind: Self.kinds[$0.kind] ?? .punctuation) }
    }
  }
  var mathPreamble: String { "" }
}

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
  let split = NSSplitView()
  /// the panel at the right: selection, copied, events (on by default)
  let inspector = Inspector()
  let page = Page()
  var editor: MarkdownEditorView?
  var zoomLabel: NSTextField!
  var images: [String: CGImage] = [:]
  /// code colours that never hold a key up (the component's LiveHighlight over the file's resources)
  lazy var live = LiveHighlight(resources)

  /// the paper under the card, the card's box and the editor inside it; a click on the paper ends editing
  final class Page: NSView {
    var onClick: () -> Void = {}
    override func mouseDown(with event: NSEvent) { onClick() }
    var paper = NSColor.windowBackgroundColor
    var card = NSColor.textBackgroundColor
    var cardRect = CGRect.zero
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
      paper.setFill()
      dirtyRect.fill()
      card.setFill()
      NSBezierPath(roundedRect: cardRect, xRadius: 10, yRadius: 10).fill()
    }
  }

  init(text: String, folder: URL, cardWidth: Double) throws {
    self.text = text
    self.folder = folder
    self.cardWidth = cardWidth
    try MarkdownAssets.fonts.get()
    resources = FileResources(folder: folder, pasted: Pasted(), math: try MarkdownAssets.engines())
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    // warm up off the main thread, as a host does at launch
    let math = resources.math
    DispatchQueue.global(qos: .userInitiated).async { MarkdownAssets.warmUp(math: math) }
    window = NSWindow(
      contentRect: CGRect(x: 0, y: 0, width: cardWidth + 160 + 340, height: 820),
      styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
    window.title = name
    scroll.hasVerticalScroller = true
    scroll.hasHorizontalScroller = true
    scroll.documentView = page
    split.isVertical = true
    split.dividerStyle = .thin
    split.addArrangedSubview(scroll)
    split.addArrangedSubview(inspector)
    inspector.widthAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true
    page.onClick = { [weak self] in self?.editor?.isEditing = false }
    window.contentView = split
    window.toolbar = toolbar()
    menu()
    rebuild()
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

  /// a file dropped on the app or opened from Finder
  func application(_ app: NSApplication, openFile path: String) -> Bool {
    open(URL(filePath: path))
  }

  @discardableResult
  func open(_ url: URL) -> Bool {
    guard let t = try? String(contentsOf: url, encoding: .utf8) else { return false }
    text = t
    folder = url.deletingLastPathComponent()
    resources = FileResources(folder: folder, pasted: resources.pasted, math: resources.math)
    live = LiveHighlight(resources)
    images = [:]
    editor?.removeFromSuperview()
    editor = nil
    window?.isDocumentEdited = false
    name = url.lastPathComponent
    window?.title = name
    if window != nil { rebuild() }
    return true
  }

  @objc func openDocument(_ s: Any?) {
    let p = NSOpenPanel()
    p.allowedContentTypes = [.init(filenameExtension: "md")!, .plainText]
    guard p.runModal() == .OK, let url = p.url else { return }
    open(url)
  }

  /// Lays the text out in the look and appearance: the editor kept (selection and undo history), only its layout new
  func rebuild() {
    let card = MarkdownLooks.card(.note, look: look, dark: dark)
    let inner = cardWidth - card.padding[1] - card.padding[3]
    let layout = BlockLayout(
      editor.map { $0.core.document } ?? MarkdownDocument(text), width: inner, theme: card.theme, layout: nil,
      resources: live)
    let e: MarkdownEditorView
    if let old = editor {
      e = old
      e.core.relayout(layout)
    } else {
      e = MarkdownEditorView(layout: layout, caret: 0)
      // a card shows its picture until it is clicked, as on the board
      e.isEditing = false
      e.delegate = self
      e.image = { [weak self] slot in self?.image(slot) }
      e.codeLanguages = [
        ("python", "Python"), ("rust", "Rust"), ("c", "C"), ("cpp", "C++"), ("cuda", "CUDA"), ("triton", "Triton"),
        ("tilelang", "TileLang"), ("mermaid", "Mermaid"), ("json", "JSON"), ("bash", "Shell"),
      ]
      editor = e
      page.addSubview(e)
      inspector.watch(e)
    }
    let ink = card.theme.colors
    e.caretColor = NSColor(cgColor: ink.accent.cg) ?? .controlAccentColor
    e.selectionColor = NSColor(cgColor: ink.accent.alpha(0.26).cg) ?? .selectedTextBackgroundColor
    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    page.paper = NSColor(cgColor: MarkdownLooks.theme(look, dark: dark).colors.surface.cg)!.blended(
      withFraction: 0.06, of: dark ? .black : .gray)!
    page.card = NSColor(cgColor: card.theme.colors.surface.cg)!
    place()
    e.needsDisplay = true
    window.makeFirstResponder(e)
  }

  /// The card at the zoom, centred, the editor at its padding
  func place() {
    guard let e = editor else { return }
    let card = MarkdownLooks.card(.note, look: look, dark: dark)
    e.zoom = zoom
    let size = card.size(content: e.core.layout.size, width: cardWidth, height: nil)
    let margin: CGFloat = 40
    let w = max(scroll.contentSize.width, size.width * zoom + 2 * margin)
    page.frame = CGRect(x: 0, y: 0, width: w, height: size.height * zoom + 2 * margin)
    let x = (w - size.width * zoom) / 2
    page.cardRect = CGRect(x: x, y: margin, width: size.width * zoom, height: size.height * zoom)
    e.setFrameOrigin(CGPoint(x: x + card.padding[3] * zoom, y: margin + (card.header + card.padding[0]) * zoom))
    page.needsDisplay = true
    zoomLabel?.stringValue = "\(Int((zoom * 100).rounded())) %"
  }

  func image(_ slot: MarkdownImageSlot) -> CGImage? {
    if let i = images[slot.src] ?? resources.pasted.picture(slot.src) { return i }
    guard !slot.src.contains("://"),
      let s = CGImageSourceCreateWithURL(folder.appending(path: slot.src) as CFURL, nil),
      let i = CGImageSourceCreateImageAtIndex(s, max(0, (slot.stillFrame ?? 1) - 1), nil)
    else { return nil }
    images[slot.src] = i
    return i
  }

  func editor(_ e: MarkdownEditorView, didResize size: CGSize) { place() }
  func editor(_ e: MarkdownEditorView, didChange source: String) { window.isDocumentEdited = true }
  @objc func toggleInspector(_ c: NSSegmentedControl) {
    inspector.isHidden = !c.isSelected(forSegment: 0)
    inspector.refresh()
  }
  func editorWantsToEnd(_ e: MarkdownEditorView) { e.isEditing = false }
  func editorDidBegin(_ e: MarkdownEditorView) {}
  func editor(_ e: MarkdownEditorView, open url: URL) { NSWorkspace.shared.open(url) }
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
    NSApp.mainMenu = main
  }
}

extension Demo: NSToolbarDelegate {
  static let items: [NSToolbarItem.Identifier] = [
    .init("inspector"), .init("look"), .init("dark"), .flexibleSpace, .init("zoom"),
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

var args = Array(CommandLine.arguments.dropFirst())
var width = 420.0
if let i = args.firstIndex(of: "--width"), i + 1 < args.count, let w = Double(args[i + 1]) {
  width = w
  args.removeSubrange(i...(i + 1))
}
let file = args.first.map { URL(filePath: $0) }
let text = try file.map { try String(contentsOf: $0, encoding: .utf8) } ?? sample
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let demo = try Demo(text: text, folder: file?.deletingLastPathComponent() ?? sampleFolder(), cardWidth: width)
if let file { demo.name = file.lastPathComponent }
app.delegate = demo
app.run()
