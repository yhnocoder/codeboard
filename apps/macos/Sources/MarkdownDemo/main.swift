// A window to try the Markdown component in, standing alone (no canvas, no board): a Markdown file laid out as a Note
// card in the board's looks, with the editor over it. ⌘O opens another file; tools/markdown/make-demo.sh makes an app.
//   swift run MarkdownDemo [file.md] [--width 420]
// The toolbar switches the look (Warm Ink, Ink Wash), light and dark, and the zoom (50 to 200 %, also ⌘= ⌘- ⌘0). Images
// are read relative to the file. The file is never written.
import AppKit
import CodeBoardMarkdown
import CodeBoardMarkdownUI
import ImageIO

/// Images next to the file, formulas and diagrams through the engines; no references, code uncoloured
struct FileResources: MarkdownResources {
  let folder: URL
  let math: MathTypesetter?
  var diagrams: DiagramRenderer? { math as? DiagramRenderer }
  func imageSize(_ src: String) -> CGSize? {
    guard !src.contains("://"), let s = CGImageSourceCreateWithURL(folder.appending(path: src) as CFURL, nil),
      let p = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any],
      let w = p[kCGImagePropertyPixelWidth] as? Int, let h = p[kCGImagePropertyPixelHeight] as? Int
    else { return nil }
    return CGSize(width: w, height: h)
  }
  func ref(label: String, target: String?) -> MarkdownRefHit? { nil }
  func highlight(lines: [String], language: String) -> [[MarkdownToken]]? { nil }
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
  """

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
  let page = Page()
  var editor: MarkdownEditorView?
  var zoomLabel: NSTextField!
  var images: [String: CGImage] = [:]

  /// the paper under the card, the card's box and the editor inside it
  final class Page: NSView {
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
    resources = FileResources(folder: folder, math: try MarkdownAssets.engines())
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    window = NSWindow(
      contentRect: CGRect(x: 0, y: 0, width: cardWidth + 160, height: 820),
      styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
    window.title = name
    scroll.hasVerticalScroller = true
    scroll.hasHorizontalScroller = true
    scroll.documentView = page
    window.contentView = scroll
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
    resources = FileResources(folder: folder, math: resources.math)
    images = [:]
    editor?.removeFromSuperview()
    editor = nil
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

  /// Lays the text out in the look and appearance, the selection kept
  func rebuild() {
    let card = MarkdownLooks.card(.note, look: look, dark: dark)
    let inner = cardWidth - card.padding[1] - card.padding[3]
    let layout = BlockLayout(
      editor.map { MarkdownDocument($0.source) } ?? MarkdownDocument(text), width: inner, theme: card.theme,
      layout: nil, resources: resources)
    let kept = editor?.selection
    editor?.removeFromSuperview()
    let e = MarkdownEditorView(layout: layout, caret: kept?.head ?? 0)
    if let kept { e.selection = kept }
    e.delegate = self
    e.image = { [weak self] slot in self?.image(slot) }
    let ink = card.theme.colors
    e.caretColor = NSColor(cgColor: ink.accent.cg) ?? .controlAccentColor
    e.selectionColor = NSColor(cgColor: ink.accent.alpha(0.26).cg) ?? .selectedTextBackgroundColor
    editor = e
    page.addSubview(e)
    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    page.paper = NSColor(cgColor: MarkdownLooks.theme(look, dark: dark).colors.surface.cg)!.blended(
      withFraction: 0.06, of: dark ? .black : .gray)!
    page.card = NSColor(cgColor: card.theme.colors.surface.cg)!
    place()
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
    if let i = images[slot.src] { return i }
    guard !slot.src.contains("://"),
      let s = CGImageSourceCreateWithURL(folder.appending(path: slot.src) as CFURL, nil),
      let i = CGImageSourceCreateImageAtIndex(s, max(0, (slot.stillFrame ?? 1) - 1), nil)
    else { return nil }
    images[slot.src] = i
    return i
  }

  func editor(_ e: MarkdownEditorView, didResize size: CGSize) { place() }
  func editorWantsToEnd(_ e: MarkdownEditorView) { window.makeFirstResponder(nil) }

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
    edit.submenu!.addItem(withTitle: "Select All", action: #selector(NSResponder.selectAll(_:)), keyEquivalent: "a")
    main.addItem(edit)
    let view = NSMenuItem()
    view.submenu = NSMenu(title: "View")
    view.submenu!.addItem(withTitle: "Zoom In", action: #selector(zoomIn(_:)), keyEquivalent: "=").target = self
    view.submenu!.addItem(withTitle: "Zoom Out", action: #selector(zoomOut(_:)), keyEquivalent: "-").target = self
    view.submenu!.addItem(withTitle: "Actual Size", action: #selector(zoomActual(_:)), keyEquivalent: "0").target = self
    main.addItem(view)
    NSApp.mainMenu = main
  }
}

extension Demo: NSToolbarDelegate {
  static let items: [NSToolbarItem.Identifier] = [.init("look"), .init("dark"), .flexibleSpace, .init("zoom")]
  func toolbarDefaultItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { Self.items }
  func toolbarAllowedItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { Self.items }
  func toolbar(_ t: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar: Bool)
    -> NSToolbarItem?
  {
    let item = NSToolbarItem(itemIdentifier: id)
    switch id.rawValue {
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
let demo = try Demo(text: text, folder: file?.deletingLastPathComponent() ?? URL(filePath: "/"), cardWidth: width)
if let file { demo.name = file.lastPathComponent }
app.delegate = demo
app.run()
