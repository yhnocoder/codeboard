import AppKit
import CodeBoardMarkdown

/// What the editor tells its host
@MainActor
public protocol MarkdownEditorDelegate: AnyObject {
  /// after each change of the source
  func editor(_ e: MarkdownEditorView, didChange source: String)
  /// the content's size changed (at 100 %)
  func editor(_ e: MarkdownEditorView, didResize size: CGSize)
  /// Esc: the user wants to stop editing
  func editorWantsToEnd(_ e: MarkdownEditorView)
  /// a click on the static picture started editing
  func editorDidBegin(_ e: MarkdownEditorView)
  /// a link opened (⌘-click, the link box's Open)
  func editor(_ e: MarkdownEditorView, open url: URL)
  /// the [[ menu's candidates for what is typed after [[ (the host's references)
  func editor(_ e: MarkdownEditorView, refCandidates query: String) -> [MarkdownRefCandidate]
  /// a picture pasted or dropped into the text: the host saves it and gives the address to write, or nil to leave it out
  func editor(_ e: MarkdownEditorView, saveImage data: Data, name: String) -> String?
  /// the / menu's Image: the host lets the user pick a picture (its bytes and file name), nil when none was picked
  func editorPicksImage(_ e: MarkdownEditorView) -> (Data, String)?
}

extension MarkdownEditorDelegate {
  public func editor(_ e: MarkdownEditorView, refCandidates query: String) -> [MarkdownRefCandidate] { [] }
  public func editor(_ e: MarkdownEditorView, open url: URL) { NSWorkspace.shared.open(url) }
  public func editor(_ e: MarkdownEditorView, saveImage data: Data, name: String) -> String? { nil }
  /// an Open panel for pictures
  public func editorPicksImage(_ e: MarkdownEditorView) -> (Data, String)? {
    let p = NSOpenPanel()
    p.allowedContentTypes = [.png, .jpeg, .gif, .webP, .svg]
    guard p.runModal() == .OK, let url = p.url, let d = try? Data(contentsOf: url) else { return nil }
    return (d, url.lastPathComponent)
  }
}

/// The editor as an NSView: a thin adapter that hands keys and the mouse to `EditorCore` and draws what it holds, with
/// the same drawing code as the static picture plus the selection and the caret. Keys go through `interpretKeyEvents`,
/// so the system's (and the user's) key bindings decide what a key means. The view is `zoom` times the layout's size: a
/// zoom only scales the drawing, the layout stays at 100 %.
@MainActor
public final class MarkdownEditorView: NSView {
  public private(set) var core: EditorCore
  public weak var delegate: MarkdownEditorDelegate?
  /// device-independent scale of the drawing (the canvas's zoom)
  public var zoom: CGFloat = 1 {
    didSet { resize() }
  }
  /// the decoded image for a slot, nil while there is none (its place stays empty)
  public var image: (MarkdownImageSlot) -> CGImage? = { _ in nil }
  public var caretColor = NSColor.controlAccentColor
  /// draws the caret without the keyboard focus (offscreen frames for a script player)
  public var alwaysShowsCaret = false
  public var selectionColor = NSColor.selectedTextBackgroundColor
  /// the caret's blink is off and nothing is laid out while frozen (a pinch or pan going on)
  public private(set) var frozen = false

  /// editing, or showing the static picture: no caret, no selection, no markers, keys and clicks left alone
  public var isEditing = true {
    didSet {
      guard isEditing != oldValue else { return }
      // measured from here: a switch made by a host, with no input event of its own to time it from
      begin()
      if isEditing {
        core.select(core.selection)
      } else {
        leaveLinkBox(later: false)
        sizePicker.close()
        // leaving: nothing stays selected, the static picture again
        core.select(MDSelection(core.selection.head))
        core.layout.setHead(nil)
      }
      changed()
      note(.editing(isEditing))
    }
  }

  let preview = MathPreview()
  let hints = MathHintList()
  let toolbar = SelectionToolbar()
  let linkBox = LinkBox()
  let sizePicker = TableSizePicker()
  let headingChip = HeadingChip()
  let findBar = FindBar()
  /// pictures sliding to where the caret's moving put them (IMAGE_SLIDE): from, to, since; and where each was
  private var slides: [String: (from: CGRect, to: CGRect, since: CFTimeInterval)] = [:]
  private var imageFrames: [String: CGRect] = [:]
  private var framesAt = -1
  private var slideLink: CADisplayLink?
  /// the find bar's matches and which one is current
  private(set) var matches: [Range<Int>] = []
  private(set) var currentMatch = -1
  let typedMenu = MenuList()
  /// the [[ menu's candidates, by the row id they were shown under
  private var refRows: [String: MarkdownRefCandidate] = [:]
  private var toolbarTimer: Timer?
  /// the selection the toolbar is for, so a change hides it until the new one settles
  private var toolbarFor: MDSelection?
  let band = CodeBand()
  /// the languages a code block's band offers (name written into the fence, label shown); the host's
  public var codeLanguages: [(name: String, label: String)] = []
  /// a code block the pointer is over (its band shows while it is)
  private var hovered: EditorCore.CodeBlock?
  private var bandTimer: Timer?

  /// What the editor receives and does, each with the main thread's time it has cost so far in that event, in ms
  /// (EditorEvent); events are built only while this is set
  public var observer: ((EditorEvent, Double) -> Void)? {
    didSet {
      core.observer = observer.map { o in { [weak self] e in o(e, self?.elapsed ?? 0) } }
    }
  }
  /// thread CPU at the start of the event being handled
  private var eventStart = 0.0
  private var elapsed: Double { BlockLayout.cpu() - eventStart }
  private func begin() { if observer != nil { eventStart = BlockLayout.cpu() } }
  private func note(_ e: @autoclosure () -> EditorEvent) { if let observer { observer(e(), elapsed) } }
  private static func mods(_ e: NSEvent) -> String {
    let f = e.modifierFlags
    return (f.contains(.control) ? "⌃" : "") + (f.contains(.option) ? "⌥" : "") + (f.contains(.shift) ? "⇧" : "")
      + (f.contains(.command) ? "⌘" : "")
  }
  private var blinkOn = true
  private var blink: Timer?
  private var settle: Timer?

  public init(layout: BlockLayout, caret: Int? = nil) {
    core = EditorCore(layout: layout, caret: caret)
    super.init(frame: CGRect(origin: .zero, size: layout.size))
    preview.isHidden = true
    addSubview(preview)
    hints.isHidden = true
    addSubview(hints)
    toolbar.isHidden = true
    addSubview(toolbar)
    toolbar.onPress = { [weak self] id in self?.toolbarPress(id) }
    addSubview(linkBox)
    headingChip.isHidden = true
    addSubview(headingChip)
    addSubview(findBar)
    findBar.onChange = { [weak self] in self?.refind(go: true) }
    findBar.onStep = { [weak self] on in self?.stepMatch(on) }
    findBar.onReplace = { [weak self] all in self?.replaceMatch(all: all) }
    findBar.onClose = { [weak self] in
      guard let self else { return }
      self.matches = []
      self.needsDisplay = true
      self.window?.makeFirstResponder(self)
    }
    headingChip.onPick = { [weak self] n in
      guard let self else { return }
      self.core.command(.heading(n))
      self.changed()
    }
    typedMenu.isHidden = true
    addSubview(typedMenu)
    linkBox.onWrite = { [weak self] p, t, u in
      guard let self, let e = MarkdownEditing.writeLink(p, text: t, url: u) else { return }
      self.core.apply(e)
      self.changed()
    }
    linkBox.onOpen = { [weak self] u in
      guard let self, let url = URL(string: u) else { return }
      self.delegate?.editor(self, open: url)
    }
    linkBox.onClose = { [weak self] in
      guard let self else { return }
      self.window?.makeFirstResponder(self)
    }
    band.isHidden = true
    addSubview(band)
    addSubview(sizePicker)
    sizePicker.dropsAt = { [weak self] r, c in
      guard let self else { return 0 }
      return MarkdownEditing.tableResize(
        rows: r, cols: c, in: MDEditState(source: self.core.source, selection: self.core.selection),
        document: self.core.document)?.dropped ?? 0
    }
    sizePicker.onPick = { [weak self] r, c in
      guard let self,
        let x = MarkdownEditing.tableResize(
          rows: r, cols: c, in: MDEditState(source: self.core.source, selection: self.core.selection),
          document: self.core.document)
      else { return }
      self.begin()
      self.core.apply(x.edit)
      self.note(.key("table size", did: "\(r) × \(c)"))
      self.changed()
    }
    registerForDraggedTypes([.fileURL, .png, .tiff])
    band.onPart = { [weak self] id, v, r in self?.bandPart(id, v, r) }
    updateTrackingAreas()
    wire(core)
  }

  private func wire(_ c: EditorCore) {
    c.onLayout = { [weak self] in
      MainActor.assumeIsolated { self?.changed() }
    }
    c.onChange = { [weak self] source in
      MainActor.assumeIsolated {
        guard let self, self.sourceMode == nil else { return }
        self.delegate?.editor(self, didChange: source)
      }
    }
  }

  // MARK: source mode

  /// ⌘/ (editor/srcmode.ts): the whole Note as its Markdown in the code font, edited as code, the caret kept both ways;
  /// leaving writes what changed back as one undo step. While it is on, `core` edits the source shown as a fenced block
  /// (the Note's own core kept here), its offsets the Note's shifted by the fence's line
  private(set) var sourceMode: (note: EditorCore, fence: Int)?

  public var isSourceMode: Bool { sourceMode != nil }

  public func toggleSourceMode() {
    if let (note, fence) = sourceMode {
      let ns = core.source as NSString
      let body =
        MarkdownEditing.run(at: fence, in: core.document).map {
          ns.substring(with: NSRange(location: $0.first, length: $0.last - $0.first))
        } ?? note.source
      let head = max(0, core.selection.head - fence)
      sourceMode = nil
      core = note
      if body != note.source, let e = EditorCore.diff(note.source, body) {
        note.apply(
          MDEdit(
            range: e.range, replacement: e.replacement, selection: MDSelection(min(head, (body as NSString).length)),
            undo: .command))
        delegate?.editor(self, didChange: note.source)
      } else {
        note.select(MDSelection(head))
      }
      changed()
      return
    }
    let src = core.source
    // a fence longer than any run of backticks in the Note
    var ticks = 3
    while src.contains(String(repeating: "`", count: ticks)) { ticks += 1 }
    let open = String(repeating: "`", count: ticks) + "\n"
    let text = open + src + "\n" + String(repeating: "`", count: ticks)
    let l = core.layout
    let layout = BlockLayout(
      MarkdownDocument(text), width: l.width, theme: l.theme, layout: nil, resources: l.resources)
    let fence = (open as NSString).length
    let shown = EditorCore(layout: layout, caret: core.selection.head + fence)
    shown.confine = fence..<(fence + (src as NSString).length)
    shown.select(MDSelection(core.selection.head + fence))
    wire(shown)
    sourceMode = (core, fence)
    core = shown
    changed()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  public override var isFlipped: Bool { true }
  public override var acceptsFirstResponder: Bool { true }
  public override func becomeFirstResponder() -> Bool {
    restartBlink()
    return true
  }
  public override func resignFirstResponder() -> Bool {
    blink?.invalidate()
    blink = nil
    needsDisplay = true
    return true
  }

  public var source: String { core.document.source }
  public var selection: MDSelection {
    get { core.selection }
    set {
      core.select(newValue)
      changed()
    }
  }

  /// A pinch or pan began: no blinking, no layout, until `thaw`
  public func freeze() {
    frozen = true
    blink?.invalidate()
    blink = nil
  }
  public func thaw() {
    frozen = false
    restartBlink()
  }

  private func resize() {
    let s = core.layout.size
    setFrameSize(CGSize(width: ceil(s.width * zoom), height: ceil(s.height * zoom)))
    needsDisplay = true
  }

  // MARK: drawing

  /// the main thread's time the last draw took, ms (a host's HUD)
  public private(set) var lastDrawMs = 0.0
  /// how many times this editor has drawn, and how many display-link frames every editor has run (a host's HUD: at rest
  /// neither moves)
  public private(set) var draws = 0
  public static var linkTicks = 0

  public override func draw(_ dirtyRect: NSRect) {
    let started = BlockLayout.cpu()
    draws += 1
    // a slide is drawn where its clock says, whether or not its display link has run since
    if let b = blockSlide { stepBlocks(at: CACurrentMediaTime() - b.since) }
    defer { lastDrawMs = BlockLayout.cpu() - started }
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let scale = zoom * (window?.backingScaleFactor ?? 2)
    ctx.saveGState()
    ctx.scaleBy(x: zoom, y: zoom)
    let clip = CGRect(
      x: dirtyRect.minX / zoom, y: dirtyRect.minY / zoom, width: dirtyRect.width / zoom,
      height: dirtyRect.height / zoom)

    // an input method's text: underlined, as the system's text views underline it
    ctx.setFillColor(caretColor.withAlphaComponent(0.8).cgColor)
    for r in core.markedRects where r.intersects(clip) {
      ctx.fill(CGRect(x: r.minX, y: r.maxY - 2.5, width: r.width, height: 1.5))
    }
    // the glyphs' positions must not depend on the scale (guideline 3.4)
    ctx.setShouldSubpixelQuantizeFonts(false)
    ctx.setAllowsFontSubpixelQuantization(false)
    // the find bar's matches, under the text, the current one stronger
    for (i, m) in matches.enumerated() {
      ctx.setFillColor(core.layout.theme.marks.highlight.alpha(i == currentMatch ? 1 : 0.55).cg)
      for r in core.rects(for: m).map(slid) where r.intersects(clip) { ctx.fill(r) }
    }
    let now = CACurrentMediaTime()
    let sliding = slides
    core.layout.draw(in: ctx, scale: scale, clip: clip) { [image] slot in
      sliding["\(slot.src)#\(slot.nth)"] == nil ? image(slot) : nil
    }
    // a sliding picture at its place now, eased
    for slot in core.layout.images {
      guard let sl = sliding["\(slot.src)#\(slot.nth)"], let pic = image(slot) else { continue }
      let k = min(1, (now - sl.since) / MarkdownTiming.imageSlide)
      let e = 1 - pow(1 - k, 3)
      let r = CGRect(
        x: sl.from.minX + (sl.to.minX - sl.from.minX) * e, y: sl.from.minY + (sl.to.minY - sl.from.minY) * e,
        width: sl.from.width + (sl.to.width - sl.from.width) * e,
        height: sl.from.height + (sl.to.height - sl.from.height) * e)
      ctx.saveGState()
      ctx.translateBy(x: r.minX, y: r.maxY)
      ctx.scaleBy(x: 1, y: -1)
      ctx.draw(pic, in: CGRect(origin: .zero, size: r.size))
      ctx.restoreGState()
    }
    // the selection over the text: under it, a code block's or a table header's fill would hide it. Translucent, so the
    // text reads through; in the static picture too (a selection made there before editing)
    // (a selected image's source is selected underneath: no selection colour on it or its caption)
    let picked = isEditing ? imageBox : nil
    if picked == nil {
      ctx.setFillColor(selectionColor.cgColor)
      for r in core.selectionRects.map(slid) where r.intersects(clip) { ctx.fill(r) }
    }
    // a selected image: a thin accent ring on the picture itself, with its corners, and the width grips on its sides
    // (markdown.css .md-imgframe::after, .md-imgrip)
    if let box = picked {
      let ring = caretColor.withAlphaComponent(0.75).cgColor
      ctx.saveGState()
      ctx.setStrokeColor(ring)
      ctx.setLineWidth(1.5)
      ctx.addPath(
        CGPath(roundedRect: box.insetBy(dx: -0.75, dy: -0.75), cornerWidth: 5, cornerHeight: 5, transform: nil))
      ctx.strokePath()
      for h in handles(box) {
        let pill = CGPath(roundedRect: h, cornerWidth: 3, cornerHeight: 3, transform: nil)
        ctx.setShadow(offset: CGSize(width: 0, height: 1), blur: 3, color: CGColor(gray: 0, alpha: 0.18))
        ctx.setFillColor(core.layout.theme.colors.surface.cg)
        ctx.addPath(pill)
        ctx.fillPath()
        ctx.setShadow(offset: .zero, blur: 0, color: nil)
        ctx.addPath(pill)
        ctx.strokePath()
      }
      ctx.restoreGState()
    }
    if let g = tableGrips, tableDrag == nil {
      // pills on the paper with a hair ring and a small shadow, the hovered cell's only
      let grips = [
        gripHover.row.flatMap { g.rows[safe: $0] }.map(rowGrip),
        gripHover.col.flatMap { g.cols[safe: $0] }.map(colGrip),
      ]
      for r in grips.compactMap({ $0 }) {
        let pill = CGPath(roundedRect: r, cornerWidth: 3, cornerHeight: 3, transform: nil)
        ctx.saveGState()
        ctx.setShadow(
          offset: CGSize(width: 0, height: 1), blur: 2,
          color: CGColor(srgbRed: 50 / 255, green: 35 / 255, blue: 10 / 255, alpha: 0.13))
        ctx.addPath(pill)
        ctx.setFillColor(core.layout.theme.colors.surface.cg)
        ctx.fillPath()
        ctx.restoreGState()
        ctx.addPath(pill)
        ctx.setStrokeColor(core.layout.theme.colors.hair.cg)
        ctx.setLineWidth(0.5)
        ctx.strokePath()
        // its dots (the grip's handle)
        ctx.setFillColor(core.layout.theme.colors.ink3.cg)
        let vertical = r.height > r.width
        for k in [-1.0, 1.0] {
          let c = vertical ? CGPoint(x: r.midX, y: r.midY + k * 2.5) : CGPoint(x: r.midX + k * 2.5, y: r.midY)
          ctx.fillEllipse(in: CGRect(x: c.x - 0.9, y: c.y - 0.9, width: 1.8, height: 1.8))
        }
      }
    }
    if let d = tableDrag {
      d.draw(in: ctx, paper: core.layout.theme.colors.surface.cg, ring: caretColor.cgColor)
    }
    if isEditing, blinkOn, alwaysShowsCaret || window?.firstResponder === self, let c = core.caretRect.map(slid),
      tableDrag == nil
    {
      // two device pixels wide whatever the zoom, on the caret's line; a gap's caret lies across the block
      let w = 2 / scale
      ctx.setFillColor(caretColor.cgColor)
      if c.height == 0 {
        ctx.fill(CGRect(x: c.minX, y: c.minY - w / 2, width: c.width, height: w))
      } else {
        ctx.fill(CGRect(x: c.minX - w / 2, y: c.minY, width: w, height: c.height))
      }
    }
    ctx.restoreGState()
  }

  private func restartBlink() {
    blink?.invalidate()
    blink = nil
    blinkOn = true
    needsDisplay = true
    // the caret blinks only where it is drawn: editing, and taking the keys (a static picture costs nothing at rest)
    guard !frozen, isEditing, alwaysShowsCaret || window?.firstResponder === self else { return }
    blink = Timer.scheduledTimer(withTimeInterval: MarkdownTiming.blinkOn, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.toggleBlink() }
    }
  }

  private func toggleBlink() {
    blinkOn.toggle()
    setNeedsDisplay(caretBounds)
    let next = blinkOn ? MarkdownTiming.blinkOn : MarkdownTiming.blinkOff
    blink = Timer.scheduledTimer(withTimeInterval: next, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.toggleBlink() }
    }
  }

  private var caretBounds: CGRect {
    guard let c = core.caretRect else { return .zero }
    return CGRect(x: c.minX * zoom - 2, y: c.minY * zoom, width: 4, height: c.height * zoom).insetBy(dx: 0, dy: -1)
  }

  /// after anything the core did: redraw, keep the caret in view, say if the size changed
  private func changed() {
    let before = frame.size
    resize()
    if frame.size != before { delegate?.editor(self, didResize: core.layout.size) }
    restartBlink()
    slideImages()
    showHeadingChip()
    scheduleToolbar()
    showMenu()
    showHints()
    // the command list and the preview share the place under the formula: the list while a command is typed
    if hints.shown { preview.isHidden = true } else { showPreview() }
    showBand()
    guard isEditing else { return }
    if let c = core.caretRect ?? core.selectionRects.last {
      scrollToVisible(
        CGRect(x: c.minX * zoom, y: c.minY * zoom, width: max(1, c.width * zoom), height: c.height * zoom))
    }
  }

  /// the slides of a table drag, one step a frame
  @objc private func dragFrame(_ link: CADisplayLink) {
    Self.linkTicks += 1
    guard let d = tableDrag else { return }
    _ = d.tick(link.targetTimestamp)
    setNeedsDisplay(d.table.insetBy(dx: -20, dy: -40).applying(CGAffineTransform(scaleX: zoom, y: zoom)))
  }

  /// A picture of blocks as they are drawn (for the float a host moves), at the screen's scale and the zoom
  public func picture(of blocks: Range<Int>) -> CGImage? {
    let r = core.frame(of: blocks)
    return r.isNull ? nil : snapshot(r)
  }

  /// a picture of part of the layout at the screen's scale, for a drag to move around
  func snapshot(_ r: CGRect) -> CGImage? {
    let scale = zoom * (window?.backingScaleFactor ?? 2)
    let w = Int((r.width * scale).rounded(.up))
    let h = Int((r.height * scale).rounded(.up))
    guard w > 0, h > 0,
      let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: scale, y: -scale)
    ctx.translateBy(x: -r.minX, y: -r.minY)
    ctx.setFillColor(core.layout.theme.colors.surface.cg)
    ctx.fill(r)
    ctx.setShouldSubpixelQuantizeFonts(false)
    ctx.setAllowsFontSubpixelQuantization(false)
    core.layout.draw(in: ctx, scale: scale, clip: r, image: image)
    return ctx.makeImage()
  }

  // MARK: pictures in and out

  /// the selected image's picture as PNG data (the host's decoded picture of it)
  func selectedImagePNG() -> Data? {
    guard let (range, _) = core.selectedImage, let atom = core.layout.rects(forAtom: range),
      let slot = core.layout.images.first(where: { $0.frame.intersects(atom) }), let pic = image(slot)
    else { return nil }
    return NSBitmapImageRep(cgImage: pic).representation(using: .png, properties: [:])
  }

  /// Pictures from a pasteboard (image data, or image files) saved through the host and written at the selection as
  /// ![](address), one undo step for all; whether there were any
  @discardableResult
  func insertImages(from pb: NSPasteboard, at point: CGPoint? = nil) -> Bool {
    var items: [(Data, String)] = []
    let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
    for u in urls where ["png", "jpg", "jpeg", "gif", "webp", "svg"].contains(u.pathExtension.lowercased()) {
      if let d = try? Data(contentsOf: u) { items.append((d, u.lastPathComponent)) }
    }
    if items.isEmpty, pb.string(forType: .string) == nil {
      if let d = pb.data(forType: .png) {
        items.append((d, "pasted.png"))
      } else if let d = pb.data(forType: .tiff),
        let png = NSBitmapImageRep(data: d)?.representation(using: .png, properties: [:])
      {
        items.append((png, "pasted.png"))
      }
    }
    guard !items.isEmpty, let delegate else { return false }
    let written = items.compactMap { d, name in delegate.editor(self, saveImage: d, name: name).map { "![](\($0))" } }
    guard !written.isEmpty else { return true }
    begin()
    if let point { core.select(MDSelection(core.layout.caret(at: point).offset)) }
    let r = core.selection.range
    let text = written.joined(separator: " ")
    core.apply(
      MDEdit(
        range: r, replacement: text, selection: MDSelection(r.lowerBound + (text as NSString).length), undo: .command))
    note(.pasted(text, rule: "pictures saved by the host"))
    changed()
    return true
  }

  /// Drags the selected image out: its Markdown and its picture go with the drag; a move that ends outside this editor
  /// takes its source out, one undo step (editor/widgets.ts dragstart / dragEnd)
  private func dragImageOut(_ e: NSEvent) {
    guard let (range, _) = core.selectedImage, let box = imageBox else { return }
    let item = NSPasteboardItem()
    item.setString(
      (core.source as NSString).substring(with: NSRange(location: range.lowerBound, length: range.count)),
      forType: .string)
    let png = selectedImagePNG()
    if let png { item.setData(png, forType: .png) }
    let drag = NSDraggingItem(pasteboardWriter: item)
    let frame = CGRect(x: box.minX * zoom, y: box.minY * zoom, width: box.width * zoom, height: box.height * zoom)
    drag.setDraggingFrame(frame, contents: png.flatMap { NSImage(data: $0) })
    draggedImage = range
    beginDraggingSession(with: [drag], event: e, source: self)
  }

  public override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
    isEditing && sender.draggingSource as? MarkdownEditorView !== self ? .copy : []
  }

  public override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    let p = convert(sender.draggingLocation, from: nil)
    return insertImages(from: sender.draggingPasteboard, at: CGPoint(x: p.x / zoom, y: p.y / zoom))
  }

  // MARK: a code block's band

  /// the code block whose band shows: the caret's while editing, else the one the pointer is over
  private var bandBlock: EditorCore.CodeBlock? {
    if isEditing, core.marked == nil, let b = core.codeBlock(at: core.selection.head) { return b }
    return isEditing ? hovered : nil
  }

  /// a table band's actions in their groups and order (tableview.ts GROUPS), and which stay first when they do not all fit
  /// (KEEP)
  private static let tableActs: [[(id: String, icon: String, tip: String)]] = [
    [
      ("rowAbove", "rowAbove", "Insert row above (⌘⇧↵)"), ("rowBelow", "rowBelow", "Insert row below (⌘↵)"),
      ("colLeft", "colLeft", "Insert column left"), ("colRight", "colRight", "Insert column right"),
    ],
    [
      ("left", "alignL", "Align column left"), ("center", "alignC", "Align column center"),
      ("right", "alignR", "Align column right"),
    ],
    [("delRow", "delRow", "Delete row (⌘⇧⌫)"), ("delCol", "delCol", "Delete column")],
  ]
  private static let tableKeep = [
    "rowBelow", "colRight", "left", "center", "right", "rowAbove", "colLeft", "delRow", "delCol",
  ]
  /// the table actions the band had no room for: they go in its ⋯ menu
  private var tableOverflow: [String] = []

  private func showBand() {
    let m = core.layout.theme.metrics
    if let b = bandBlock {
      bandTimer?.invalidate()
      // the code block's box: the code's padding around its lines, from the first line's own top (its caret box: the whole
      // line; a glyph's box sits lower, which left a gap under the band)
      guard let first = core.layout.caretRect(MDCaret(b.body.lowerBound)) else { return }
      // the panel as drawn around its first line (a look's margins around the block are not the panel)
      let panel = core.layout.panel(
        around: CGPoint(x: first.midX, y: first.midY), of: b.body.lowerBound, color: core.layout.theme.colors.codeBlock)
      let top = panel?.minY ?? first.minY - CGFloat(m.codePadding[0])
      let frame = core.layout.blockFrames.first { $0.minY <= top + 1 && $0.maxY >= top } ?? .zero
      band.block = b
      band.table = nil
      let wraps = core.layout.info?.wrap?.contains(b.index) ?? false
      let name =
        (b.language?.isEmpty ?? true) ? "Plain text" : (codeLanguages.first { $0.0 == b.language }?.1 ?? b.language!)
      band.place(
        over: CGRect(x: frame.minX * zoom, y: top * zoom, width: frame.width * zoom, height: 1),
        key: "code \(b.range.lowerBound)", zoom: zoom, theme: core.layout.theme,
        parts: [
          .init(id: "language", kind: .language(name), tip: "Language"),
          .init(id: "copy", kind: .icon("copy"), tip: "Copy code"),
          .init(id: "wrap", kind: .icon("wrap"), tip: "Wrap lines", on: wraps),
          .init(id: "more", kind: .icon("dots"), tip: "More"),
        ], fill: core.layout.theme.colors.codeBlock, table: false, radius: CGFloat(m.codeRadius))
      band.show(true)
      return
    }
    if isEditing, core.marked == nil, let t = MarkdownEditing.tablePlace(at: core.selection.head, in: core.document),
      let g = tableGrips
    {
      bandTimer?.invalidate()
      band.block = nil
      band.table = t.block
      let align = t.column < t.table.align.count ? t.table.align[t.column] : .none
      let rows = t.table.rows.count
      let cols = t.table.rows.first?.count ?? 0
      // as many actions as the table's width holds, the most used first; the rest in ⋯
      let room = g.box.width - (8 + 7 + 8 + 27) - (6 + 14 + 6 + 8 + 40)
      var keep = Set<String>()
      var used: CGFloat = 0
      for id in Self.tableKeep {
        let groupGap: CGFloat = keep.isEmpty ? 0 : 6
        guard used + 27 + groupGap <= room else { break }
        keep.insert(id)
        used +=
          27
          + (Self.tableActs.firstIndex { $0.contains { $0.id == id } }.map { gi in
            Self.tableActs[gi].contains { keep.contains($0.id) && $0.id != id } ? 0 : groupGap
          } ?? 0)
      }
      tableOverflow = Self.tableActs.flatMap { $0 }.map(\.id).filter { !keep.contains($0) }
      var parts: [CodeBand.Part] = [.init(id: "size", kind: .size("\(rows) × \(cols)"), tip: "Table size")]
      var firstGroup = true
      for group in Self.tableActs {
        let shown = group.filter { keep.contains($0.id) }
        for (i, a) in shown.enumerated() {
          let on =
            (a.id == "left" && align == .left) || (a.id == "center" && align == .center)
            || (a.id == "right" && align == .right)
          parts.append(.init(id: a.id, kind: .icon(a.icon), tip: a.tip, on: on, gapBefore: i == 0 && !firstGroup))
        }
        if !shown.isEmpty { firstGroup = false }
      }
      parts.append(.init(id: "more", kind: .icon("dots"), tip: "More"))
      band.place(
        over: CGRect(x: g.box.minX * zoom, y: g.box.minY * zoom, width: g.box.width * zoom, height: 1),
        key: "table \(t.block.lowerBound)", zoom: zoom, theme: core.layout.theme, parts: parts,
        fill: core.layout.theme.colors.fill, table: true, radius: 6)
      band.show(true)
      return
    }
    // gone after BAND_GRACE, so passing from the block to its band does not drop it
    bandTimer?.invalidate()
    guard band.shown else { return }
    bandTimer = Timer.scheduledTimer(withTimeInterval: MarkdownTiming.bandGrace, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.bandBlock == nil,
          MarkdownEditing.tablePlace(at: self.core.selection.head, in: self.core.document) == nil
        else { return }
        self.band.show(false)
      }
    }
  }

  private func bandPart(_ id: String, _ v: NSView, _ r: CGRect) {
    begin()
    switch id {
    case "language": pickLanguage(from: v, at: r)
    case "copy": copyCode()
    case "wrap": toggleWrap()
    case "rowBelow": core.command(.addRow(below: true))
    case "rowAbove": core.command(.addRow(below: false))
    case "delRow": core.command(.deleteRow)
    case "colRight": core.command(.column(.add(after: true)))
    case "colLeft": core.command(.column(.add(after: false)))
    case "delCol": core.command(.column(.delete))
    case "more":
      moreMenu(from: v, at: r)
      return
    case "size":
      guard let t = MarkdownEditing.tablePlace(at: core.selection.head, in: core.document) else { return }
      sizePicker.open(
        above: convert(r, from: v), rows: t.table.rows.count, cols: t.table.rows.first?.count ?? 1,
        theme: core.layout.theme)
      return
    case "left", "center", "right":
      let al: MDTable.Align = id == "left" ? .left : id == "center" ? .center : .right
      let now = MarkdownEditing.tablePlace(at: core.selection.head, in: core.document).map {
        $0.column < $0.table.align.count ? $0.table.align[$0.column] : .none
      }
      core.command(.column(.align(now == al ? .none : al)))
    default: return
    }
    note(.key("band \(id)", did: "selection \(core.selection.head)"))
    changed()
  }

  /// a band's ⋯: a table's actions that had no room, a code block's rest (codeblock.ts openMenu)
  private func moreMenu(from v: NSView, at r: CGRect) {
    let menu = NSMenu()
    if band.table != nil {
      let tips = Dictionary(uniqueKeysWithValues: Self.tableActs.flatMap { $0 }.map { ($0.id, $0.tip) })
      for id in tableOverflow {
        let item = NSMenuItem(title: tips[id] ?? id, action: #selector(bandMenuPicked(_:)), keyEquivalent: "")
        item.representedObject = id
        item.target = self
        menu.addItem(item)
      }
      if menu.items.isEmpty { menu.addItem(withTitle: "No more actions", action: nil, keyEquivalent: "") }
    } else {
      let item = NSMenuItem(title: "Copy code", action: #selector(bandMenuPicked(_:)), keyEquivalent: "")
      item.representedObject = "copy"
      item.target = self
      menu.addItem(item)
    }
    menu.popUp(positioning: nil, at: CGPoint(x: r.minX, y: r.maxY), in: v)
  }

  @objc private func bandMenuPicked(_ item: NSMenuItem) {
    guard let id = item.representedObject as? String else { return }
    bandPart(id, self, .zero)
  }

  private func copyCode() {
    guard let b = band.block else { return }
    let t = (core.source as NSString).substring(with: NSRange(location: b.body.lowerBound, length: b.body.count))
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(t, forType: .string)
    note(.copied([("public.utf8-plain-text", t)]))
  }

  private func toggleWrap() {
    guard let b = band.block else { return }
    begin()
    let on = !(core.layout.info?.wrap?.contains(b.index) ?? false)
    core.setWrap(on, of: b)
    note(.key("band Wrap", did: on ? "wrap" : "no wrap"))
    changed()
  }

  private func pickLanguage(from v: NSView, at r: CGRect) {
    guard let b = band.block, b.info != nil else { return }
    let menu = NSMenu()
    let current = b.language ?? ""
    for (name, label) in [("", "Plain text")] + codeLanguages {
      let item = NSMenuItem(title: label, action: #selector(languagePicked(_:)), keyEquivalent: "")
      item.representedObject = name
      item.target = self
      item.state = name == current ? .on : .off
      menu.addItem(item)
    }
    menu.popUp(positioning: nil, at: CGPoint(x: r.minX, y: r.maxY), in: v)
  }

  @objc private func languagePicked(_ item: NSMenuItem) {
    guard let b = band.block, let name = item.representedObject as? String else { return }
    begin()
    core.setLanguage(name, of: b)
    note(.key("band language", did: name.isEmpty ? "plain text" : name))
    changed()
  }

  public override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas { removeTrackingArea(t) }
    addTrackingArea(
      NSTrackingArea(
        rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
  }

  public override func mouseMoved(with e: NSEvent) {
    let p = convert(e.locationInWindow, from: nil)
    let at = CGPoint(x: p.x / zoom, y: p.y / zoom)
    hoverGrips(at)
    cursor(at: p, modifiers: e.modifierFlags).set()
    var over: EditorCore.CodeBlock?
    if isEditing, band.isHidden || !band.bandFrame.contains(p) {
      let c = core.layout.caret(at: at)
      if let b = core.codeBlock(at: c.offset) {
        let boxes = core.rects(for: b.body.lowerBound..<max(b.body.lowerBound + 1, b.body.upperBound))
        let pad = CGFloat(core.layout.theme.metrics.codePadding[0])
        if let f = boxes.first, let l = boxes.last, at.y >= f.minY - pad, at.y <= l.maxY + pad { over = b }
      }
    } else if band.shown, band.bandFrame.contains(p) {
      over = band.block
    }
    guard over != hovered else { return }
    hovered = over
    showBand()
  }

  public override func mouseExited(with e: NSEvent) {
    hovered = nil
    showBand()
  }

  /// the chip of the heading the caret is in
  private func showHeadingChip() {
    guard isEditing, core.marked == nil,
      case .heading(let level) = MarkdownEditing.context(at: core.selection.head, in: core.document).leaf,
      let r = MarkdownEditing.run(at: core.selection.head, in: core.document),
      let box = core.layout.caretRect(MDCaret(r.first))
    else {
      headingChip.isHidden = true
      return
    }
    headingChip.level = level
    headingChip.theme = core.layout.theme
    headingChip.zoom = zoom
    // its first baseline: the caret box at the heading's start runs from the font's ascent above it to its descent below,
    // the descent about a fifth of the whole
    headingChip.place(baseline: (box.maxY - box.height * 0.22) * zoom, left: box.minX * zoom)
  }

  // MARK: find and replace

  /// ⌘F and ⌥⌘F: the bar, its query the selection's text when it has one on one line
  func openFind(replace: Bool) {
    let s = core.selection.range
    if !s.isEmpty, s.count < 200 {
      let t = (core.source as NSString).substring(with: NSRange(location: s.lowerBound, length: s.count))
      if !t.contains("\n") { findBar.query.stringValue = t }
    }
    findBar.show(replace: replace, theme: core.layout.theme, in: visibleRect)
    refind(go: false)
  }

  /// the matches again (the query, the case switch or the text changed); `go` selects the first at or after the caret
  func refind(go: Bool) {
    matches = core.find(findBar.query.stringValue, caseSensitive: findBar.caseSensitive)
    let head = core.selection.range.lowerBound
    currentMatch = matches.isEmpty ? -1 : (matches.firstIndex { $0.lowerBound >= head } ?? 0)
    findBar.count.stringValue =
      matches.isEmpty ? (findBar.query.stringValue.isEmpty ? "" : "0") : "\(currentMatch + 1)/\(matches.count)"
    if go, currentMatch >= 0 { selectMatch() }
    needsDisplay = true
  }

  private func selectMatch() {
    let m = matches[currentMatch]
    core.select(MDSelection(anchor: m.lowerBound, head: m.upperBound))
    findBar.count.stringValue = "\(currentMatch + 1)/\(matches.count)"
    if let r = core.rects(for: m).first {
      scrollToVisible(CGRect(x: r.minX * zoom, y: r.minY * zoom, width: r.width * zoom, height: r.height * zoom))
    }
    needsDisplay = true
  }

  /// ↵ / ⇧↵ in the bar
  func stepMatch(_ on: Bool) {
    guard !matches.isEmpty else { return }
    currentMatch = (currentMatch + (on ? 1 : -1) + matches.count) % matches.count
    selectMatch()
  }

  /// ↵ in the replacement: the current match replaced and the next one selected; ⌘↵: all of them, one undo step
  func replaceMatch(all: Bool) {
    guard !matches.isEmpty else { return }
    let with = findBar.replacement.stringValue
    begin()
    if all {
      let n = matches.count
      core.applyAll(
        matches.map { MDEdit(range: $0, replacement: with, selection: MDSelection($0.lowerBound), undo: .command) },
        select: MDSelection(matches[0].lowerBound))
      note(.key("replace all", did: "\(n) replaced"))
    } else {
      let m = matches[max(0, currentMatch)]
      core.apply(
        MDEdit(
          range: m, replacement: with, selection: MDSelection(m.lowerBound + (with as NSString).length), undo: .command)
      )
      note(.key("replace", did: "at \(m.lowerBound)"))
    }
    refind(go: !all)
    changed()
  }

  // MARK: blocks sliding

  /// Each block's source and top now, what `slideBlocks(from:)` takes after a change
  public func blockPlaces() -> [(String, CGFloat)] {
    let ns = core.source as NSString
    return zip(core.document.blocks, core.layout.tops).map { b, y in
      (ns.substring(with: NSRange(location: b.range.lowerBound, length: b.range.count)), y)
    }
  }

  /// After a ⌘ move (landing, taking away, putting back) every block still there slides from where it was to its new
  /// place over FLIP_MS (blockmove.ts's flip) instead of jumping; blocks are matched by their source. Blocks in `except`
  /// (counted as block moves count them: the ones just landed, which the host's copy glides into) stay put
  public func slideBlocks(from before: [(String, CGFloat)], except: Range<Int> = 0..<0) {
    var was: [String: [CGFloat]] = [:]
    for (t, y) in before { was[t, default: []].append(y) }
    let landed = Set(except.compactMap { core.movable[safe: $0] })
    var offsets: [Int: CGFloat] = [:]
    for (i, (t, y)) in blockPlaces().enumerated() {
      guard !landed.contains(i), let old = was[t]?.first else { continue }
      was[t]?.removeFirst()
      if abs(old - y) > 0.5 { offsets[i] = old - y }
    }
    // nothing slides in a window nobody sees (off screen, covered, a locked screen): its display link would not run, and
    // the blocks would stay drawn where they started (without a window, a frame tool steps it by hand)
    guard !offsets.isEmpty, window.map({ $0.occlusionState.contains(.visible) }) ?? true else { return }
    blockSlide = (offsets, CACurrentMediaTime())
    core.layout.drawOffsets = offsets
    if blockLink == nil {
      let link = displayLink(target: self, selector: #selector(blockFrame(_:)))
      link.add(to: .main, forMode: .common)
      blockLink = link
    }
    needsDisplay = true
  }

  private var blockSlide: (from: [Int: CGFloat], since: CFTimeInterval)?
  private var blockLink: CADisplayLink?

  @objc private func blockFrame(_ link: CADisplayLink) {
    Self.linkTicks += 1
    guard let b = blockSlide else { return }
    stepBlocks(at: link.targetTimestamp - b.since)
  }

  /// a box in a block where that block is drawn now: off its place while it slides
  private func slid(_ r: CGRect) -> CGRect {
    let offsets = core.layout.drawOffsets
    guard !offsets.isEmpty else { return r }
    let tops = core.layout.tops
    // the last block starting above the box's middle holds it
    var lo = 0
    var hi = tops.count
    while lo < hi {
      let mid = (lo + hi) / 2
      if tops[mid] <= r.midY { lo = mid + 1 } else { hi = mid }
    }
    return r.offsetBy(dx: 0, dy: offsets[lo - 1] ?? 0)
  }

  /// the slide `t` seconds in (the display link's clock, or a frame tool's)
  public func stepBlocks(at t: CFTimeInterval) {
    guard let b = blockSlide else { return }
    let k = min(1, max(0, t / MarkdownTiming.blockFlip))
    let e = MarkdownTiming.ease(k)
    core.layout.drawOffsets = b.from.mapValues { $0 * (1 - e) }
    needsDisplay = true
    if k >= 1 {
      core.layout.drawOffsets = [:]
      blockSlide = nil
      blockLink?.invalidate()
      blockLink = nil
    }
  }

  /// blocks sliding now (tests)
  var slidingBlocks: Int { blockSlide?.from.count ?? 0 }

  /// where the band is and the code panel under the caret, in the editor's points (a host's check)
  public var bandGeometry: String {
    let c = core.caretRect ?? .zero
    let panel = core.layout.panel(
      around: CGPoint(x: c.midX, y: c.midY), of: core.selection.head, color: core.layout.theme.colors.codeBlock)
    return
      "band \(band.bandFrame) strip \(band.stripFrame) shown \(band.shown) panel \(panel.map { "\($0)" } ?? "none")"
  }

  /// whether anything of the editor's still runs on its own: the caret's blink, a slide, a drag's scrolling, a pending
  /// toolbar, band or reveal. At rest in the static picture nothing does
  public var isTicking: Bool {
    blink != nil || slideLink != nil || blockLink != nil || dragLink != nil || toolbarTimer?.isValid == true
      || bandTimer?.isValid == true || settle?.isValid == true
  }

  // MARK: pictures sliding

  /// A picture the caret's moving put elsewhere (its source opened or closed, no edit made) slides there over
  /// IMAGE_SLIDE instead of jumping (editor/imageslide.ts); an edit moves pictures at once
  private func slideImages() {
    var now: [String: CGRect] = [:]
    for slot in core.layout.images { now["\(slot.src)#\(slot.nth)"] = slot.frame }
    if framesAt == core.revision {
      let t = CACurrentMediaTime()
      for (k, to) in now {
        guard let from = imageFrames[k], from != to else { continue }
        slides[k] = (from, to, t)
      }
    } else {
      slides = [:]
    }
    imageFrames = now
    framesAt = core.revision
    if !slides.isEmpty, slideLink == nil {
      let link = displayLink(target: self, selector: #selector(slideFrame(_:)))
      link.add(to: .main, forMode: .common)
      slideLink = link
    }
  }

  @objc private func slideFrame(_ link: CADisplayLink) {
    Self.linkTicks += 1
    let t = link.targetTimestamp
    slides = slides.filter { t - $0.value.since < MarkdownTiming.imageSlide }
    needsDisplay = true
    if slides.isEmpty {
      slideLink?.invalidate()
      slideLink = nil
    }
  }

  /// the pictures sliding now (tests)
  var slidingImages: Int { slides.count }

  // MARK: typed menus

  /// / [[ : menus while their query is typed (editor/menu.tsx)
  private func showMenu() {
    guard isEditing, core.marked == nil,
      let t = MarkdownEditing.menuToken(
        MDEditState(source: core.source, selection: core.selection), document: core.document),
      typedMenu.dismissedAt != t.from, let c = core.caretRect
    else {
      if !isEditing || core.selection.head < (typedMenu.dismissedAt ?? Int.max) { typedMenu.dismissedAt = nil }
      return typedMenu.hide()
    }
    let items: [MDMenuItem]
    switch t.kind {
    case .slash: items = MarkdownEditing.slashMenu(t.query)
    case .emoji: items = MarkdownEditing.emojiMenu(t.query)
    case .ref:
      let found = delegate?.editor(self, refCandidates: t.query) ?? []
      refRows = [:]
      items = found.prefix(10).enumerated().map { i, r in
        refRows["ref\(i)"] = r
        return MDMenuItem(title: r.title, hint: r.crumb ?? "", id: "ref\(i)")
      }
    }
    let caret = CGRect(x: c.minX * zoom, y: c.minY * zoom, width: 1, height: c.height * zoom)
    typedMenu.show(items, token: t, under: caret, theme: core.layout.theme)
  }

  /// a typed menu's row taken
  private func take(_ item: MDMenuItem, _ t: (kind: MDMenuKind, from: Int, query: String)) {
    begin()
    let q = core.selection.head
    switch t.kind {
    case .slash:
      if let e = MarkdownEditing.applySlash(
        item, from: t.from, in: MDEditState(source: core.source, selection: core.selection), document: core.document)
      {
        core.apply(e)
      }
      // a picture the host picks, saved as a pasted one is, written at the caret
      if item.id == "image", let delegate, let (data, name) = delegate.editorPicksImage(self),
        let address = delegate.editor(self, saveImage: data, name: name)
      {
        let text = "![](\(address))"
        let at = core.selection.head
        core.apply(
          MDEdit(
            range: at..<at, replacement: text, selection: MDSelection(at + (text as NSString).length), undo: .command))
      }
    case .emoji:
      let text = ":\(item.id):"
      core.apply(
        MDEdit(
          range: t.from..<q, replacement: text, selection: MDSelection(t.from + (text as NSString).length),
          undo: .command))
    case .ref:
      guard let r = refRows[item.id] else { break }
      // a ]] the pair put in after the caret is taken in
      let ns = core.source as NSString
      let end = q + 2 <= ns.length && ns.substring(with: NSRange(location: q, length: 2)) == "]]" ? q + 2 : q
      let text = "[[" + r.label + (r.target.map { "#^" + $0 } ?? "") + "]]"
      core.apply(
        MDEdit(
          range: t.from..<end, replacement: text, selection: MDSelection(t.from + (text as NSString).length),
          undo: .command))
    }
    typedMenu.hide()
    note(.key("menu \(item.title)", did: "selection \(core.selection.head)"))
    changed()
  }

  // MARK: the link box

  /// presses a control of the band showing now, by its id ("size", "copy", "wrap", "more", a table action), as a click on it
  /// does (a host's check)
  public func pressBandPart(_ id: String) {
    guard band.shown, let (_, r) = band.partRect(id) else { return }
    bandPart(id, band, r)
  }

  /// the link box for the link at the caret, as ⌘K opens it (a host's check)
  public func openLinkBoxForCheck() { openLinkBox() }

  /// ⌘K, the toolbar's Link, a click on a link the caret is not in: the box for the link at the selection, or for a new
  /// one on the selected text
  func openLinkBox() {
    guard isEditing,
      let p = MarkdownEditing.linkPlace(
        in: MDEditState(source: core.source, selection: core.selection), document: core.document),
      let first = core.rects(for: p.range.lowerBound..<max(p.range.lowerBound + 1, p.range.upperBound)).first
    else { return }
    toolbar.hide()
    let r = CGRect(x: first.minX * zoom, y: first.minY * zoom, width: first.width * zoom, height: first.height * zoom)
    linkBox.show(p, under: r, theme: core.layout.theme)
  }

  /// what the link box held when a press left it, written once the press has put the caret where it was pressed
  private var leftLink: (place: MDLinkPlace, text: String, url: String)?

  /// The link box is left for somewhere else (bubble.tsx leaveLink): it closes; what it holds is written, now or after the
  /// press that left it (`later`); fields left as they were write nothing
  func leaveLinkBox(later: Bool) {
    guard !linkBox.isHidden, let p = linkBox.place else { return }
    let held = (p, linkBox.text.stringValue, linkBox.url.stringValue)
    linkBox.isHidden = true
    linkBox.place = nil
    leftLink = held
    if !later { writeLeftLink() }
  }

  private func writeLeftLink() {
    guard let (p, text, url) = leftLink else { return }
    leftLink = nil
    guard text != p.text || url != p.url, let e = MarkdownEditing.writeLink(p, text: text, url: url) else { return }
    // the caret stays where the press put it, moved by what the write changed before it
    let head = core.selection.head
    let delta = (e.replacement as NSString).length - e.range.count
    let keep = head >= e.range.upperBound ? head + delta : head <= e.range.lowerBound ? head : e.range.lowerBound
    core.apply(MDEdit(range: e.range, replacement: e.replacement, selection: MDSelection(keep), undo: e.undo))
    changed()
  }

  // MARK: the selection's toolbar

  /// the buttons for the selection: all while editing, Bold and Highlight on the static picture
  private var toolbarButtons: [SelectionToolbar.Button] {
    let st = MDEditState(source: core.source, selection: core.selection)
    func w(_ o: String, _ c: String) -> Bool { MarkdownEditing.isWrapped(o, c, in: st) }
    let all: [SelectionToolbar.Button] = [
      .init(id: "bold", symbol: "bold", tip: "Bold (⌘B)", on: w("**", "**")),
      .init(id: "italic", symbol: "italic", tip: "Italic (⌘I)", on: w("*", "*") && !w("**", "**")),
      .init(id: "strike", symbol: "strike", tip: "Strikethrough (⌘⇧S)", on: w("~~", "~~")),
      .init(id: "highlight", symbol: "highlight", tip: "Highlight (⌘⇧H)", on: w("==", "==")),
      .init(id: "code", symbol: "code", tip: "Inline Code (⌘E)", on: w("`", "`")),
      .init(id: "link", symbol: "link", tip: "Link (⌘K)", on: false),
      .init(id: "math", symbol: "math", tip: "Inline Math", on: w("$", "$")),
      .init(id: "annot", symbol: "annot", tip: "Handwritten Note", on: false),
    ]
    return isEditing ? all : all.filter { $0.id == "bold" || $0.id == "highlight" }
  }

  /// a host's gesture over the Note (a ⌘ move) is going on: no selection toolbar over it until it ends
  public var holdsToolbar = false {
    didSet { if holdsToolbar != oldValue { scheduleToolbar() } }
  }

  /// the toolbar comes up once the selection has stood still for TOOLBAR_SETTLE, the button up
  private func scheduleToolbar() {
    let s = core.selection
    guard !s.isEmpty, !holdsToolbar, core.selectedImage == nil, core.marked == nil, tableDrag == nil, resizing == nil,
      MarkdownEditing.run(at: s.range.lowerBound, in: core.document)?.kind == .inline
    else {
      toolbarTimer?.invalidate()
      toolbarFor = nil
      toolbar.hide()
      return
    }
    if toolbarFor == s, !toolbar.isHidden {
      placeToolbar()
      return
    }
    toolbar.hide()
    toolbarFor = s
    toolbarTimer?.invalidate()
    toolbarTimer = Timer.scheduledTimer(withTimeInterval: MarkdownTiming.toolbarSettle, repeats: false) {
      [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.toolbarFor == self.core.selection, NSEvent.pressedMouseButtons == 0 else { return }
        self.placeToolbar()
      }
    }
  }

  func placeToolbar() {
    guard let first = core.selectionRects.first else { return toolbar.hide() }
    let line = CGRect(
      x: first.minX * zoom, y: first.minY * zoom, width: first.width * zoom, height: first.height * zoom)
    toolbar.show(toolbarButtons, over: line, in: visibleRect, theme: core.layout.theme)
  }

  func toolbarPress(_ id: String) {
    begin()
    let kind: MDMarkKind? =
      switch id {
      case "bold": .strong
      case "italic": .emphasis
      case "strike": .strike
      case "highlight": .highlight
      case "code": .code
      default: nil
      }
    if let kind {
      core.command(.toggle(kind))
    } else if id == "link" {
      openLinkBox()
    } else if id == "math" {
      // $…$ around the selection, or off again
      let st = MDEditState(source: core.source, selection: core.selection)
      if let e = MarkdownEditing.wrap("$", "$", in: st, document: core.document) { core.apply(e) }
    }
    note(.key("toolbar \(id)", did: "selection \(core.selection.anchor)…\(core.selection.head)"))
    changed()
  }

  /// the command list while a \\command is typed in a formula
  private func showHints() {
    guard isEditing, let f = core.formulaBeforeCaret,
      let t = MarkdownEditing.mathToken(f.tex, caret: (f.tex as NSString).length)
    else {
      hints.hide()
      return
    }
    let from = f.start + t.from
    if hints.dismissedAt == from { return hints.hide() }
    hints.dismissedAt = nil
    let tex = core.layout.resources.mathPreamble
    let items = MarkdownEditing.mathCompletions(t.query, tex: f.tex, preamble: tex)
    guard let c = core.caretRect else { return hints.hide() }
    let caret = CGRect(x: c.minX * zoom, y: c.minY * zoom, width: 1, height: c.height * zoom)
    hints.show(items, token: (from, t.query), under: caret, theme: core.layout.theme, resources: core.layout.resources)
  }

  /// the preview of the formula the caret is in, under its source
  private func showPreview() {
    let l = core.layout
    guard isEditing, core.selection.isEmpty, let h = l.head, h == core.selection.head,
      let f = MarkdownEditing.formula(at: h, in: l.document)
    else {
      preview.show(nil, under: .zero, theme: l.theme, resources: l.resources)
      return
    }
    let boxes = l.selectionRects(f.range)
    let u = boxes.dropFirst().reduce(boxes.first ?? .zero) { $0.union($1) }
    let r = CGRect(x: u.minX * zoom, y: u.minY * zoom, width: u.width * zoom, height: u.height * zoom)
    // where the TeX starts in the source: the caret's place in it, and where a fix writes
    let ns = core.source as NSString
    let inside = ns.range(of: f.latex, range: NSRange(location: f.range.lowerBound, length: f.range.count))
    let start = inside.location == NSNotFound ? f.range.lowerBound : inside.location
    preview.onFix = { [weak self] range, text in
      guard let self else { return }
      self.begin()
      let r = (start + range.lowerBound)..<(start + range.upperBound)
      self.core.apply(
        MDEdit(
          range: r, replacement: text, selection: MDSelection(r.lowerBound + (text as NSString).length), undo: .command)
      )
      self.note(.key("formula fix", did: text.isEmpty ? "removed" : text))
      self.changed()
    }
    preview.show(
      (f.latex, f.display), under: r, theme: l.theme, resources: l.resources, caret: core.selection.head - start)
  }

  // MARK: the mouse

  public override func mouseDown(with e: NSEvent) {
    begin()
    // a press anywhere in the Note leaves the link box: it closes at once, what it holds is written on the release
    leaveLinkBox(later: true)
    sizePicker.close()
    let p = convert(e.locationInWindow, from: nil)
    let at = CGPoint(x: p.x / zoom, y: p.y / zoom)
    defer {
      note(.mouse(.down, clicks: e.clickCount, modifiers: Self.mods(e), offset: core.selection.head))
    }
    window?.makeFirstResponder(self)
    settle?.invalidate()
    guard isEditing else {
      // the static picture: a drag selects its text, a click without one starts editing there (the board's selected
      // card: singleSelectedBodySelectsText, clickSelectedCardEdits)
      pressed = (at, false)
      core.mouseDown(at: at, clicks: 1, extend: false)
      changed()
      return
    }
    // a press on a selected image's picture may start dragging it out (not on its grips, which overlap its edges: they
    // resize it; taken as a click on the picture, their release opened its source)
    if let box = imageBox, box.contains(at), e.clickCount == 1, !onImageGrip(at, box) {
      imageDragFrom = at
      note(.key("press on the selected picture", did: "drag out, or open its source on release"))
      return
    }
    // a press on a column's right edge or a row's bottom edge: its width or height (layout info, editor/table.ts)
    if let g = tableGrips, let index = core.tableIndex(at: core.selection.head),
      g.box.insetBy(dx: -4, dy: -4).contains(at)
    {
      let col = g.cols.indices.first { abs(g.cols[$0].maxX - at.x) <= 3 }
      let row = col == nil ? g.rows.indices.first { abs(g.rows[$0].maxY - at.y) <= 3 } : nil
      if col != nil || row != nil {
        let given = core.layout.info?.tables?[safe: index] ?? nil
        let cols = given?.cols ?? Array(repeating: nil, count: g.cols.count)
        let rows = given?.rows ?? Array(repeating: nil, count: g.rows.count)
        tableSize =
          col.map { (true, $0, at.x, g.cols[$0].width, index, cols, rows) }
          ?? (false, row!, at.y, g.rows[row!].height, index, cols, rows)
        return
      }
    }
    // a press on a table's row or column grip: moving it
    if let g = tableGrips {
      let row = gripHover.row.flatMap { r in rowGrip(g.rows[r]).insetBy(dx: -4, dy: -3).contains(at) ? r : nil }
      let col = gripHover.col.flatMap { c in colGrip(g.cols[c]).insetBy(dx: -3, dy: -4).contains(at) ? c : nil }
      if row != nil || col != nil, let pic = snapshot(g.box) {
        tableDrag = TableDrag(
          axis: row != nil ? .row : .column, from: row ?? col!, boxes: row != nil ? g.rows : g.cols, table: g.box,
          picture: pic, start: row != nil ? at.y : at.x)
        let link = displayLink(target: self, selector: #selector(dragFrame(_:)))
        link.add(to: .main, forMode: .common)
        dragLink = link
        needsDisplay = true
        return
      }
    }
    // a press on a selected image's handle: resizing it, symmetrically about its centre (editor/image.ts); a double-click
    // on a handle gives it back its full width
    if let box = imageBox, let k = handles(box).firstIndex(where: { $0.insetBy(dx: -4, dy: -4).contains(at) }) {
      if e.clickCount == 2 {
        note(.key("double press on an image grip", did: "full width"))
        core.setImageWidth(nil)
        changed()
        return
      }
      note(.key("press on an image grip", did: k == 0 ? "resize from the left" : "resize from the right"))
      resizing = (box.width, at, box.width, k == 0)
      return
    }
    let linkBefore = linkAtCaret()
    core.mouseDown(at: at, clicks: e.clickCount, extend: e.modifierFlags.contains(.shift))
    // a click on a link: ⌘ opens it; without, when the caret was not in it, its box comes up on the release
    // (editor/session.ts handleClick)
    if e.clickCount == 1, !e.modifierFlags.contains(.shift), let l = linkAtCaret(), l.range != linkBefore?.range {
      if e.modifierFlags.contains(.command), let url = URL(string: l.url) {
        delegate?.editor(self, open: url)
      } else {
        linkOnRelease = true
      }
    }
    changed()
  }

  /// the link the caret is in, if any
  private func linkAtCaret() -> MDLinkPlace? {
    guard core.selection.isEmpty,
      let p = MarkdownEditing.linkPlace(
        in: MDEditState(source: core.source, selection: core.selection), document: core.document), p.exists
    else { return nil }
    return p
  }
  /// a click landed on a link the caret was not in: its box comes up on the release
  private var linkOnRelease = false

  /// A click on the static picture starts editing there: the caret where the picture was clicked (a drawn formula's
  /// source opened), its markers shown at once, as the web editor reveals on focus with no button held. `at` is in the
  /// layout's points
  public func enter(at p: CGPoint) {
    core.mouseDown(at: p, clicks: 1, extend: false)
    core.mouseUp()
    isEditing = true
    core.settle()
    changed()
    delegate?.editorDidBegin(self)
  }

  /// the selected image's box in the layout's points
  var imageBox: CGRect? {
    guard let (range, _) = core.selectedImage, let atom = core.layout.rects(forAtom: range) else { return nil }
    return core.layout.images.first { $0.frame.intersects(atom) }?.frame ?? atom
  }

  /// the width grips on the picture's two sides, centred (markdown.css .md-imgrip: 6 × 26, 3.75 outside its edge)
  func handles(_ box: CGRect) -> [CGRect] {
    let (w, h): (CGFloat, CGFloat) = (6, 26)
    return [
      CGRect(x: box.minX - 3.75 - w / 2 + 3, y: box.midY - h / 2, width: w, height: h),
      CGRect(x: box.maxX + 3.75 - w / 2 - 3, y: box.midY - h / 2, width: w, height: h),
    ]
  }

  /// the image grips reach past the editor's edge (as on the web, into the card's padding): a press there is still the
  /// editor's, not the card's under it (which ends editing)
  public override func hitTest(_ point: NSPoint) -> NSView? {
    if isEditing, let box = imageBox {
      let p = convert(point, from: superview)
      if onImageGrip(CGPoint(x: p.x / zoom, y: p.y / zoom), box), !bounds.contains(p) { return self }
    }
    return super.hitTest(point)
  }

  private func onImageGrip(_ at: CGPoint, _ box: CGRect) -> Bool {
    handles(box).contains { $0.insetBy(dx: -4, dy: -4).contains(at) }
  }

  /// a press on the selected image, before it has moved far enough to drag it out
  private var imageDragFrom: CGPoint?
  /// the source of an image being dragged out
  var draggedImage: Range<Int>?

  /// a table row or column being moved by its grip
  private var tableDrag: TableDrag?
  /// a column's right edge or a row's bottom edge being dragged: which, where the drag began, its size then
  private var tableSize:
    (column: Bool, k: Int, start: CGFloat, from: CGFloat, index: Int, cols: [Double?], rows: [Double?])?
  private var dragLink: CADisplayLink?

  /// The caret's table's rows and columns as boxes, and the grips: a short bar at each row's left edge and over each
  /// column's top edge (editor/tableview.ts)
  private var tableGrips: (table: MDTable, rows: [CGRect], cols: [CGRect], box: CGRect)? {
    guard isEditing, core.marked == nil, let p = MarkdownEditing.tablePlace(at: core.selection.head, in: core.document)
    else { return nil }
    let cells = core.layout.cellBoxes(of: p.table)
    guard let head = cells.first, !head.isEmpty else { return nil }
    let rows = cells.map { r in r.dropFirst().reduce(r.first ?? .zero) { $0.union($1) } }
    let cols = (0..<head.count).map { c in cells.compactMap { $0[safe: c] }.dropFirst().reduce(head[c]) { $0.union($1) }
    }
    let box = rows.dropFirst().reduce(rows[0]) { $0.union($1) }
    return (p.table, rows, cols, box)
  }

  /// the pointer over a table: resize arrows on its edges, an open hand on its grips
  func tableCursor(_ at: CGPoint) -> NSCursor? {
    guard let g = tableGrips, g.box.insetBy(dx: -8, dy: -8).contains(at) else { return nil }
    if g.cols.contains(where: { abs($0.maxX - at.x) <= 3 }) { return .resizeLeftRight }
    if g.rows.contains(where: { abs($0.maxY - at.y) <= 3 }) { return .resizeUpDown }
    if gripHover.row.flatMap({ g.rows[safe: $0] }).map({ rowGrip($0).insetBy(dx: -4, dy: -3).contains(at) }) == true
      || gripHover.col.flatMap({ g.cols[safe: $0] }).map({ colGrip($0).insetBy(dx: -3, dy: -4).contains(at) }) == true
    {
      return .openHand
    }
    return nil
  }

  /// whether a link is under a point
  func linkUnder(_ at: CGPoint) -> Bool {
    let q = core.layout.caret(at: at).offset
    guard
      let p = MarkdownEditing.linkPlace(
        in: MDEditState(source: core.source, selection: MDSelection(q)), document: core.document)
    else { return false }
    return p.exists
  }

  /// the grips of the hovered cell (tableview.ts hover, .md-tgrip): one 8 × 16 at the left of its row (not the header
  /// row), 3 in from the table's edge, one 16 × 7 at the top of its column, 2.5 down
  private func rowGrip(_ r: CGRect) -> CGRect { CGRect(x: r.minX + 3, y: r.midY - 8, width: 8, height: 16) }
  private func colGrip(_ r: CGRect) -> CGRect { CGRect(x: r.midX - 8, y: r.minY + 2.5, width: 16, height: 7) }
  /// the cell under the pointer in the caret's table: its row and column, whose grips show
  private var gripHover: (row: Int?, col: Int?) = (nil, nil)

  func hoverGrips(_ at: CGPoint) {
    var next: (row: Int?, col: Int?) = (nil, nil)
    if let g = tableGrips, g.box.insetBy(dx: -4, dy: -4).contains(at) {
      // a grip keeps its row or column while the pointer is on it, past the cell's edge
      let row = g.rows.indices.first { g.rows[$0].minY <= at.y && at.y < g.rows[$0].maxY }
      let col = g.cols.indices.first { g.cols[$0].minX <= at.x && at.x < g.cols[$0].maxX }
      next = (row.flatMap { $0 > 0 ? $0 : nil }, col)
    }
    guard next.row != gripHover.row || next.col != gripHover.col else { return }
    gripHover = next
    needsDisplay = true
  }

  /// a handle being dragged: the image's width as it will be (the layout's points), and where the drag began
  private var resizing: (width: CGFloat, start: CGPoint, from: CGFloat, left: Bool)?

  /// the press that started editing is still down: its drag and release are not a selection
  private var entering = false
  /// a press on the static picture, and whether it has moved into a drag (a selection) yet
  private var pressed: (at: CGPoint, dragged: Bool)?

  public override func mouseDragged(with e: NSEvent) {
    if let from = imageDragFrom {
      let p = convert(e.locationInWindow, from: nil)
      guard hypot(p.x / zoom - from.x, p.y / zoom - from.y) * zoom > 4 else { return }
      imageDragFrom = nil
      dragImageOut(e)
      return
    }
    if let t = tableSize {
      let p = convert(e.locationInWindow, from: nil)
      let at = t.column ? p.x / zoom : p.y / zoom
      let size = Double(max(t.column ? 25 : 16, t.from + at - t.start).rounded())
      var cols = t.cols
      var rows = t.rows
      if t.column {
        while cols.count <= t.k { cols.append(nil) }
        cols[t.k] = size
      } else {
        while rows.count <= t.k { rows.append(nil) }
        rows[t.k] = size
      }
      core.setTableSize(t.index, cols: cols, rows: rows, done: false)
      changed()
      return
    }
    if let d = tableDrag {
      let p = convert(e.locationInWindow, from: nil)
      d.move(to: d.axis == .row ? p.y / zoom : p.x / zoom)
      setNeedsDisplay(d.table.insetBy(dx: -20, dy: -40).applying(CGAffineTransform(scaleX: zoom, y: zoom)))
      return
    }
    if let r = resizing {
      let p = convert(e.locationInWindow, from: nil)
      let dx = (p.x / zoom - r.start.x) * (r.left ? -1 : 1)
      // both sides move: twice the pointer's way; at least 48 points, on an 8-point grid
      let w = min(core.layout.width, max(48, ((r.from + 2 * dx) / 8).rounded() * 8))
      guard w != r.width else { return }
      resizing?.width = w
      // the picture scales under the handle and the text below follows, every frame; written on release
      core.previewImageWidth(Double(w / core.layout.width))
      changed()
      return
    }
    if !isEditing, let (start, _) = pressed {
      let p = convert(e.locationInWindow, from: nil)
      let at = CGPoint(x: p.x / zoom, y: p.y / zoom)
      guard hypot(at.x - start.x, at.y - start.y) * zoom > 3 || pressed!.dragged else { return }
      pressed!.dragged = true
      core.mouseDragged(to: at)
      changed()
      return
    }
    guard isEditing, !entering else { return }
    let p = convert(e.locationInWindow, from: nil)
    core.mouseDragged(to: CGPoint(x: p.x / zoom, y: p.y / zoom))
    changed()
    autoscroll(with: e)
  }

  public override func mouseUp(with e: NSEvent) {
    defer { writeLeftLink() }
    if imageDragFrom != nil {
      // a click on the image already selected: its source opens (editor/widgets.ts)
      imageDragFrom = nil
      if core.openImage() { changed() }
      return
    }
    if let t = tableSize {
      tableSize = nil
      let info = core.layout.info?.tables?[safe: t.index] ?? nil
      core.setTableSize(t.index, cols: info?.cols, rows: info?.rows, done: true)
      changed()
      return
    }
    if let d = tableDrag {
      tableDrag = nil
      dragLink?.invalidate()
      dragLink = nil
      if d.to != d.from {
        let state = MDEditState(source: core.source, selection: core.selection)
        let edit =
          d.axis == .row
          ? MarkdownEditing.tableMove(row: d.from, to: d.to, in: state, document: core.document)
          : MarkdownEditing.tableMove(column: d.from, to: d.to, in: state, document: core.document)
        if let edit { core.apply(edit) }
      }
      changed()
      return
    }
    if let r = resizing {
      resizing = nil
      core.endImagePreview()
      // one write on release: the width as a share of the body
      if r.width != r.from { core.setImageWidth(Double(r.width / core.layout.width)) }
      changed()
      return
    }
    begin()
    defer { note(.mouse(.up, clicks: e.clickCount, modifiers: Self.mods(e), offset: core.selection.head)) }
    if let (start, dragged) = pressed {
      pressed = nil
      core.mouseUp()
      if !dragged { enter(at: start) }
      return
    }
    if entering {
      entering = false
      return
    }
    core.mouseUp()
    if linkOnRelease {
      linkOnRelease = false
      openLinkBox()
    }
    guard core.revealPending else { return }
    settle = Timer.scheduledTimer(withTimeInterval: MarkdownTiming.revealAfterClick, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        // timed from the timer, not from the click 450 ms before (that wait is not the main thread's)
        self.begin()
        guard self.core.settle() else { return }
        self.changed()
      }
    }
  }

  // MARK: keys

  /// a key right after a click: the markers shown first, the key handled on that layout (editor/inline.ts)
  func revealFirst() {
    settle?.invalidate()
    if core.revealPending, core.settle() { changed() }
  }

  /// ⌘B ⌘I ⌘U ⌘E ⌘⇧` ⌘⇧S ⌘⇧X ⌘⇧H, ⌘0–⌘6, ⌘= ⌘- (editor/typora.ts)
  public override func performKeyEquivalent(with e: NSEvent) -> Bool {
    guard isEditing, window?.firstResponder === self else { return super.performKeyEquivalent(with: e) }
    let flags = e.modifierFlags.intersection([.command, .shift, .option, .control])
    guard let key = e.charactersIgnoringModifiers?.lowercased(), flags.contains(.command), !flags.contains(.control)
    else { return super.performKeyEquivalent(with: e) }
    // ⌥⌘: lists, quote, a table, a formula block (editor/typora.ts); the key's letter, whatever ⌥ makes of it
    if flags.contains(.option) {
      let letter = e.keyCode
      let c: MDCommand? =
        switch letter {
        case 31: .block(.ordered)  // O
        case 32: .block(.bullet)  // U
        case 12: .block(.quote)  // Q
        case 7: .block(.task)  // X
        case 17: .insertTable  // T
        case 11: .insertMathBlock  // B
        default: nil
        }
      if letter == 3, !flags.contains(.shift) {
        openFind(replace: true)
        return true
      }
      guard let c, !flags.contains(.shift) else { return super.performKeyEquivalent(with: e) }
      begin()
      core.command(c)
      note(.key(Self.mods(e) + (e.charactersIgnoringModifiers ?? ""), did: "\(c)"))
      changed()
      return true
    }
    if !flags.contains(.shift), key == "]" || key == "[" {
      begin()
      if core.command(key == "]" ? .indent : .outdent) { changed() }
      return true
    }
    if key == "/", !flags.contains(.shift), core.codeBlock(at: core.selection.head) == nil || sourceMode != nil {
      toggleSourceMode()
      return true
    }
    if key == "f", !flags.contains(.shift) {
      openFind(replace: flags.contains(.option))
      return true
    }
    if !flags.contains(.shift), key == "d" {
      core.selectWord()
      changed()
      return true
    }
    if !flags.contains(.shift), key == "l" {
      core.selectParagraph()
      changed()
      return true
    }
    if flags.contains(.shift), key == "v" {
      paste(nil)
      return true
    }
    let shift = flags.contains(.shift)
    if key == "k", !shift {
      openLinkBox()
      return true
    }
    if key == "\r" || e.keyCode == 36 || e.keyCode == 51 {
      // ⌘↵ / ⌘⇧↵ a table row below or above, ⌘⇧⌫ the row deleted
      let c: MDCommand = e.keyCode == 51 ? .deleteRow : .addRow(below: !shift)
      if e.keyCode != 51 || shift, core.command(c) {
        note(.key(Self.mods(e) + (e.keyCode == 51 ? "⌫" : "↵"), did: "\(c)"))
        changed()
        return true
      }
      return super.performKeyEquivalent(with: e)
    }
    if key == "/", !shift, core.toggleComment() {
      changed()
      return true
    }
    let c: MDCommand? =
      switch (key, shift) {
      case ("b", false): .toggle(.strong)
      case ("i", false): .toggle(.emphasis)
      case ("u", false): .toggle(.underline)
      case ("e", false), ("`", true), ("~", true): .toggle(.code)
      case ("s", true), ("x", true): .toggle(.strike)
      case ("h", true): .toggle(.highlight)
      case ("=", false): .headingStep(-1)
      case ("-", false): .headingStep(1)
      case (let k, false) where k.count == 1 && "0123456".contains(k): .heading(Int(k)!)
      default: nil
      }
    guard let c else { return super.performKeyEquivalent(with: e) }
    begin()
    let did = core.command(c)
    note(.key(Self.mods(e) + key.uppercased(), did: did ? "\(c)" : "\(c): nothing here"))
    changed()
    return true
  }

  public override func keyDown(with e: NSEvent) {
    // a key on a selection made in the static picture starts editing with that selection
    if !isEditing, !core.selection.isEmpty { isEditing = true }
    guard isEditing else { return super.keyDown(with: e) }
    revealFirst()
    interpretKeyEvents([e])
  }

  public override func doCommand(by selector: Selector) {
    // a typed menu takes ↑ ↓ ↵ Tab Esc while it is up
    if typedMenu.shown, let token = typedMenu.token {
      switch selector {
      case #selector(moveUp(_:)): return typedMenu.step(-1)
      case #selector(moveDown(_:)): return typedMenu.step(1)
      case #selector(insertNewline(_:)), #selector(insertTab(_:)):
        take(typedMenu.items[typedMenu.chosen], token)
        return
      case #selector(cancelOperation(_:)):
        typedMenu.dismissedAt = token.from
        typedMenu.hide()
        return
      default: break
      }
    }
    // the formula command list takes ↑ ↓ ↵ Tab Esc while it is up
    if hints.shown, let token = hints.token {
      switch selector {
      case #selector(moveUp(_:)): return hints.step(-1)
      case #selector(moveDown(_:)): return hints.step(1)
      case #selector(insertNewline(_:)), #selector(insertTab(_:)):
        core.insertMathCommand(hints.items[hints.chosen], from: token.from)
        changed()
        return
      case #selector(cancelOperation(_:)):
        hints.dismissedAt = token.from
        hints.hide()
        return
      default: break
      }
    }
    begin()
    defer {
      note(.key(NSStringFromSelector(selector), did: "selection \(core.selection.anchor)…\(core.selection.head)"))
    }
    revealFirst()
    if let action = Self.moves[selector] {
      action(core)
    } else if let k = Self.keys[selector] {
      // ⇧↵ arrives as insertNewline: too
      let shift = NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false
      core.key(k == .enter && shift ? .shiftEnter : k)
    } else if let unit = Self.deletes[selector] {
      deleteBy(unit.0, forward: unit.1)
    } else if selector == #selector(cancelOperation(_:)) {
      delegate?.editorWantsToEnd(self)
      return
    } else {
      return
    }
    changed()
  }

  /// ⌥⌫, ⌘⌫ and their forward forms: to the word or line boundary; a selection goes whole
  private func deleteBy(_ unit: EditorCore.Unit, forward: Bool) {
    let s = core.selection
    guard s.isEmpty else {
      core.key(.backspace)
      return
    }
    let to: Int
    switch unit {
    case .word: to = MarkdownEditing.wordStep(from: s.head, forward: forward, in: core.document, head: core.layout.head)
    default: to = core.layout.lineBoundary(core.caret, end: forward).offset
    }
    guard to != s.head else {
      core.key(forward ? .delete : .backspace)
      return
    }
    let r = min(to, s.head)..<max(to, s.head)
    core.apply(MDEdit(range: r, replacement: "", selection: MDSelection(r.lowerBound)))
  }

  static let keys: [Selector: MDKey] = [
    #selector(insertNewline(_:)): .enter, #selector(insertLineBreak(_:)): .shiftEnter,
    #selector(insertNewlineIgnoringFieldEditor(_:)): .enter, #selector(deleteBackward(_:)): .backspace,
    #selector(deleteForward(_:)): .delete, #selector(deleteBackwardByDecomposingPreviousCharacter(_:)): .backspace,
    #selector(insertTab(_:)): .tab, #selector(insertBacktab(_:)): .shiftTab,
  ]
  static let deletes: [Selector: (EditorCore.Unit, Bool)] = [
    #selector(deleteWordBackward(_:)): (.word, false), #selector(deleteWordForward(_:)): (.word, true),
    #selector(deleteToBeginningOfLine(_:)): (.line, false), #selector(deleteToEndOfLine(_:)): (.line, true),
  ]

  // MARK: undo and the clipboard

  /// The host changed the core itself (a ⌘ move's take or put, the other half of a linked undo): redraw, resize, report
  public func coreChanged() { changed() }

  @objc public func undo(_ sender: Any?) {
    begin()
    core.undo()
    changed()
  }
  @objc public func redo(_ sender: Any?) {
    begin()
    core.redo()
    changed()
  }
  @objc public func copy(_ sender: Any?) {
    begin()
    guard let t = core.copy() else { return }
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(t, forType: .string)
    // and as HTML, for apps that paste formatted text (the web editor's copy gives text/html too)
    let html = MarkdownHTML.render(t)
    pb.setString(html, forType: .html)
    var types = [("public.utf8-plain-text", t), ("public.html", html)]
    // a selected image: its picture too, as the web's ⌘C copies the picture itself (editor/image.ts copyImage)
    if let png = selectedImagePNG() {
      pb.setData(png, forType: .png)
      types.append(("public.png", "\(png.count) bytes"))
    }
    note(.copied(types))
  }
  @objc public func cut(_ sender: Any?) {
    begin()
    guard isEditing, let t = core.cut() else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(t, forType: .string)
    note(.copied([("public.utf8-plain-text", t)]))
    changed()
  }
  @objc public func paste(_ sender: Any?) {
    // a picture (or picture files) on the pasteboard: saved by the host, written as images
    if isEditing, insertImages(from: NSPasteboard.general) { return }
    guard isEditing else { return }
    let pb = NSPasteboard.general
    let plainOnly = (sender as? NSMenuItem)?.action == #selector(pasteAsPlainText(_:)) || sender == nil
    var p = MDPaste(plain: pb.string(forType: .string))
    if !plainOnly {
      // VS Code marks its copies with the language; HTML from elsewhere is read as Markdown
      if let vs = pb.data(forType: NSPasteboard.PasteboardType("vscode-editor-data")),
        let o = try? JSONSerialization.jsonObject(with: vs) as? [String: Any]
      {
        p.vscodeLanguage = o["mode"] as? String ?? ""
      } else if let html = pb.string(forType: .html) {
        p.htmlMarkdown = HTMLMarkdown.markdown(html)
      }
    }
    guard p.plain != nil || p.htmlMarkdown != nil else { return }
    core.paste(p)
    changed()
  }
  @objc public func pasteAsPlainText(_ sender: Any?) { paste(sender) }

  @objc public func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
    switch item.action {
    case #selector(undo(_:)): core.canUndo
    case #selector(redo(_:)): core.canRedo
    case #selector(copy(_:)): !core.selection.isEmpty
    case #selector(cut(_:)): isEditing && !core.selection.isEmpty
    case #selector(paste(_:)), #selector(pasteAsPlainText(_:)): NSPasteboard.general.string(forType: .string) != nil
    default: responds(to: item.action)
    }
  }

  public override func selectAll(_ sender: Any?) {
    core.selectAll()
    changed()
  }

  /// the system's text commands this editor does, by selector
  static let moves: [Selector: (EditorCore) -> Void] = {
    var m: [Selector: (EditorCore) -> Void] = [:]
    func both(_ plain: String, _ unit: EditorCore.Unit, forward: Bool) {
      m[Selector(plain + ":")] = { $0.move(unit, forward: forward, extend: false) }
      m[Selector(plain + "AndModifySelection:")] = { $0.move(unit, forward: forward, extend: true) }
    }
    both("moveLeft", .character, forward: false)
    both("moveRight", .character, forward: true)
    both("moveBackward", .character, forward: false)
    both("moveForward", .character, forward: true)
    both("moveWordLeft", .word, forward: false)
    both("moveWordRight", .word, forward: true)
    both("moveWordBackward", .word, forward: false)
    both("moveWordForward", .word, forward: true)
    both("moveToLeftEndOfLine", .line, forward: false)
    both("moveToRightEndOfLine", .line, forward: true)
    both("moveToBeginningOfLine", .line, forward: false)
    both("moveToEndOfLine", .line, forward: true)
    both("moveToBeginningOfParagraph", .paragraph, forward: false)
    both("moveToEndOfParagraph", .paragraph, forward: true)
    both("moveParagraphBackward", .paragraph, forward: false)
    both("moveParagraphForward", .paragraph, forward: true)
    both("moveToBeginningOfDocument", .document, forward: false)
    both("moveToEndOfDocument", .document, forward: true)
    m[#selector(moveUp(_:))] = { $0.moveVertically(down: false, extend: false) }
    m[#selector(moveDown(_:))] = { $0.moveVertically(down: true, extend: false) }
    m[#selector(moveUpAndModifySelection(_:))] = { $0.moveVertically(down: false, extend: true) }
    m[#selector(moveDownAndModifySelection(_:))] = { $0.moveVertically(down: true, extend: true) }
    m[#selector(selectAll(_:))] = { $0.selectAll() }
    m[#selector(selectWord(_:))] = { $0.selectWord() }
    m[#selector(selectParagraph(_:))] = { $0.selectParagraph() }
    m[#selector(selectLine(_:))] = { $0.selectParagraph() }
    return m
  }()
}

// MARK: input methods

extension MarkdownEditorView: @preconcurrency NSTextInputClient {
  /// Ranges here are source offsets; while an input method composes, offsets from its start are in the source as shown
  /// with the marked text in it
  public func insertText(_ string: Any, replacementRange: NSRange) {
    begin()
    let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
    defer { note(.key("type \"\(text)\"", did: "selection \(core.selection.head)")) }
    if core.marked == nil, replacementRange.location != NSNotFound {
      core.select(MDSelection(anchor: replacementRange.location, head: NSMaxRange(replacementRange)))
    }
    core.insert(text)
    changed()
  }

  public func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
    let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
    if core.marked == nil, replacementRange.location != NSNotFound {
      core.select(MDSelection(anchor: replacementRange.location, head: NSMaxRange(replacementRange)))
    }
    core.setMarked(text, selected: selectedRange)
    changed()
  }

  public func unmarkText() {
    guard let m = core.marked else { return }
    core.insert(m.text)
    changed()
  }

  public func selectedRange() -> NSRange {
    if let m = core.marked { return NSRange(location: m.at + m.selected.location, length: m.selected.length) }
    let r = core.selection.range
    return NSRange(location: r.lowerBound, length: r.count)
  }

  public func markedRange() -> NSRange {
    guard let m = core.marked else { return NSRange(location: NSNotFound, length: 0) }
    return NSRange(location: m.at, length: (m.text as NSString).length)
  }

  public func hasMarkedText() -> Bool { core.marked != nil }

  public func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString?
  {
    let ns = core.layout.document.source as NSString
    let r = NSIntersectionRange(range, NSRange(location: 0, length: ns.length))
    actualRange?.pointee = r
    return NSAttributedString(string: ns.substring(with: r))
  }

  public func validAttributesForMarkedText() -> [NSAttributedString.Key] { [.underlineStyle] }

  /// Where the candidate window goes: the range's first line, on screen
  public func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
    actualRange?.pointee = range
    let box =
      core.rects(for: range.location..<NSMaxRange(range)).first
      ?? core.layout.caretRect(MDCaret(range.location)) ?? .zero
    let r = CGRect(x: box.minX * zoom, y: box.minY * zoom, width: max(1, box.width * zoom), height: box.height * zoom)
    guard let w = window else { return r }
    return w.convertToScreen(convert(r, to: nil))
  }

  public func characterIndex(for point: NSPoint) -> Int {
    guard let w = window else { return NSNotFound }
    let p = convert(w.convertPoint(fromScreen: point), from: nil)
    return core.layout.caret(at: CGPoint(x: p.x / zoom, y: p.y / zoom)).offset
  }
}

extension MarkdownEditorView: NSDraggingSource {
  public func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext)
    -> NSDragOperation
  {
    context == .outsideApplication ? .copy : [.copy, .move]
  }

  public func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
    defer { draggedImage = nil }
    guard operation == .move, let r = draggedImage, core.selectedImage?.range == r else { return }
    core.apply(MDEdit(range: r, replacement: "", selection: MDSelection(r.lowerBound), undo: .command))
    changed()
  }
}
