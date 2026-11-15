import AppKit
import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CodeUI
import Foundation
import ImageIO
import TreeSitterHighlight

/// The component on its own: one Markdown file in a window, read and edited in place in the component's sample look,
/// light or dark as the system is. ⌘O opens another file, ⌘S writes it back; images are read from beside the file
@MainActor
final class EditorDemo: NSObject, NSApplicationDelegate, MarkdownEditorDelegate {
  static let width: CGFloat = 680
  static let margin: CGFloat = 36
  let window = NSWindow(
    contentRect: CGRect(x: 0, y: 0, width: width, height: 760),
    styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
  let page = Page()
  private(set) var file: URL?
  private(set) var editor: MarkdownEditorView?
  private var dark = false
  private var images: [String: CGImage] = [:]
  private var appearance: NSKeyValueObservation?
  /// the formula and diagram engines; without them formulas and diagrams show as their source
  let math: MathTypesetter? = try? MarkdownAssets.engines()

  /// A file to open, else a short sample
  init(file: URL?) throws {
    super.init()
    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.documentView = page
    window.contentView = scroll
    window.minSize = CGSize(width: 360, height: 240)
    window.delegate = page
    page.onResize = { [weak self] in self?.place() }
    if let file { try open(file) } else { show(Self.sample, folder: FileManager.default.temporaryDirectory) }
    appearance = window.observe(\.effectiveAppearance) { [weak self] _, _ in
      MainActor.assumeIsolated { self?.followAppearance() }
    }
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    menu()
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

  func application(_ app: NSApplication, openFile path: String) -> Bool { (try? open(URL(filePath: path))) != nil }

  /// Shows `url`'s Markdown
  func open(_ url: URL) throws {
    let text = try String(contentsOf: url, encoding: .utf8)
    file = url
    window.title = url.lastPathComponent
    window.representedURL = url
    show(text, folder: url.deletingLastPathComponent())
  }

  /// Writes what is being edited back to the file it came from
  func save() throws {
    guard let file, let editor else { return }
    try editor.core.source.write(to: file, atomically: true, encoding: .utf8)
    window.isDocumentEdited = false
  }

  private var folder = URL(filePath: "/")

  private func show(_ text: String, folder: URL) {
    self.folder = folder
    images = [:]
    dark = window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    let layout = BlockLayout(
      MarkdownDocument(text), width: Self.width - 2 * Self.margin, theme: .sample(dark: dark), layout: nil,
      resources: Resources(folder: folder, math: math))
    if let editor {
      editor.core.relayout(layout)
    } else {
      let e = MarkdownEditorView(layout: layout, caret: 0)
      e.delegate = self
      e.image = { [weak self] slot in self?.image(slot) }
      e.codeLanguages = [
        ("python", "Python"), ("rust", "Rust"), ("c", "C"), ("cpp", "C++"), ("cuda", "CUDA"), ("mermaid", "Mermaid"),
        ("json", "JSON"), ("bash", "Shell"),
      ]
      page.addSubview(e)
      editor = e
    }
    window.isDocumentEdited = false
    colour()
    place()
  }

  /// The theme again when the system's appearance changes, the text and the caret kept
  private func followAppearance() {
    guard let editor else { return }
    let now = window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    guard now != dark else { return }
    dark = now
    images = [:]
    let l = editor.core.layout
    editor.core.relayout(
      BlockLayout(
        editor.core.document, width: Self.width - 2 * Self.margin, theme: .sample(dark: dark), layout: l.info,
        resources: Resources(folder: folder, math: math)))
    colour()
    editor.needsDisplay = true
  }

  private func colour() {
    let t = MarkdownTheme.sample(dark: dark)
    page.paper = NSColor(cgColor: t.colors.surface.cg) ?? .textBackgroundColor
    editor?.caretColor = NSColor(cgColor: t.colors.accent.cg) ?? .controlAccentColor
    editor?.selectionColor = NSColor(cgColor: t.colors.accent.alpha(0.26).cg) ?? .selectedTextBackgroundColor
    page.needsDisplay = true
  }

  /// The editor centred at the page's top, the page as tall as it
  private func place() {
    guard let editor, let scroll = page.enclosingScrollView else { return }
    let size = editor.core.layout.size
    let w = max(scroll.contentSize.width, size.width + 2 * Self.margin)
    page.frame.size = CGSize(width: w, height: max(scroll.contentSize.height, size.height + 2 * Self.margin))
    editor.frame = CGRect(x: ((w - size.width) / 2).rounded(), y: Self.margin, width: size.width, height: size.height)
  }

  private func image(_ slot: MarkdownImageSlot) -> CGImage? {
    guard !slot.src.contains("://") else { return nil }
    let url = folder.appending(path: slot.src)
    if let i = images[url.path] { return i }
    let data = try? Data(contentsOf: url)
    let i: CGImage? =
      if let data, MarkdownSVG.isSVG(data) {
        MarkdownSVG.image(data, pixelWidth: slot.pixelWidth(at: 2), dark: dark)
      } else {
        CGImageSourceCreateWithURL(url as CFURL, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }
      }
    images[url.path] = i
    return i
  }

  // MARK: the editor's delegate

  func editor(_ e: MarkdownEditorView, didChange source: String) { window.isDocumentEdited = true }
  func editor(_ e: MarkdownEditorView, didResize size: CGSize) { place() }
  func editorWantsToEnd(_ e: MarkdownEditorView) {}
  func editorDidBegin(_ e: MarkdownEditorView) {}

  // MARK: menus

  @objc func openDocument(_ s: Any?) {
    let p = NSOpenPanel()
    p.allowedContentTypes = [.init(filenameExtension: "md")!, .plainText]
    guard p.runModal() == .OK, let url = p.url else { return }
    try? open(url)
  }

  @objc func saveDocument(_ s: Any?) { try? save() }

  private func menu() {
    let bar = NSMenu()
    func add(_ title: String, _ items: [NSMenuItem]) {
      let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      top.submenu = NSMenu(title: title)
      for i in items { top.submenu!.addItem(i) }
      bar.addItem(top)
    }
    add(
      "Markdown", [NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")])
    let open = NSMenuItem(title: "Open…", action: #selector(openDocument(_:)), keyEquivalent: "o")
    let save = NSMenuItem(title: "Save", action: #selector(saveDocument(_:)), keyEquivalent: "s")
    open.target = self
    save.target = self
    add("File", [open, save])
    add(
      "Edit",
      [
        NSMenuItem(title: "Undo", action: #selector(MarkdownEditorView.undo(_:)), keyEquivalent: "z"),
        NSMenuItem(title: "Redo", action: #selector(MarkdownEditorView.redo(_:)), keyEquivalent: "Z"),
        .separator(),
        NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"),
        NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"),
        NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"),
        NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"),
      ])
    NSApp.mainMenu = bar
  }

  static let sample = """
    # Markdown

    Text with **bold**, *italics*, `code`, ==a highlight== and [a link](https://example.com); 中文与 English 混排。

    - a list
      - nested
    - [x] a task

    > a quote

    | a | b |
    |---|--:|
    | 1 | 2 |

    ```python
    def step(batch):
        return model(batch)
    ```

    $$
    \\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}
    $$
    """
}

/// What a file's Markdown draws with: images beside the file, code coloured by TreeSitterHighlight, no references
struct Resources: MarkdownResources {
  let folder: URL
  let math: MathTypesetter?
  var diagrams: DiagramRenderer? { math as? DiagramRenderer }
  /// a fence's language as the highlighter names its grammars
  static let grammars: [String: String] = [
    "python": "python", "py": "python", "c": "c", "h": "c", "cpp": "cpp", "c++": "cpp", "cc": "cpp", "hpp": "cpp",
    "cuda": "cuda-cpp", "cu": "cuda-cpp", "rust": "rust", "rs": "rust",
  ]
  static let highlighter = Highlighter()

  func imageSize(_ src: String) -> CGSize? {
    guard !src.contains("://") else { return nil }
    let url = folder.appending(path: src)
    if let d = try? Data(contentsOf: url), MarkdownSVG.isSVG(d) { return MarkdownSVG.size(d) }
    guard let s = CGImageSourceCreateWithURL(url as CFURL, nil),
      let p = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any],
      let w = p[kCGImagePropertyPixelWidth] as? Int, let h = p[kCGImagePropertyPixelHeight] as? Int
    else { return nil }
    return CGSize(width: w, height: h)
  }
  func ref(label: String, target: String?) -> MarkdownRefHit? { nil }
  func highlight(lines: [String], language: String) -> [[CodeRun]]? {
    guard let grammar = Self.grammars[language.lowercased()] else { return nil }
    return Self.highlighter.tokens(lines: lines, language: grammar).map { line in
      line.map { CodeRun(columns: $0.columns, style: $0.kind.rawValue) }
    }
  }
  var mathPreamble: String { "" }
}

/// The paper behind the editor, flipped so the editor sits at its top
final class Page: NSView, NSWindowDelegate {
  var paper = NSColor.textBackgroundColor
  var onResize: () -> Void = {}
  override var isFlipped: Bool { true }
  override func draw(_ r: NSRect) {
    paper.setFill()
    r.fill()
  }
  func windowDidResize(_ n: Notification) { onResize() }
}
