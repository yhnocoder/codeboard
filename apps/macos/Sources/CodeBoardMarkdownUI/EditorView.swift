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
}

/// The editor as an NSView: a thin adapter that hands keys and the mouse to `EditorCore` and draws what it holds, with
/// the same drawing code as the static picture plus the selection and the caret. Keys go through `interpretKeyEvents`,
/// so the system's (and the user's) key bindings decide what a key means. The view is `zoom` times the layout's size: a
/// zoom only scales the drawing, the layout stays at 100 %.
@MainActor
public final class MarkdownEditorView: NSView {
  public let core: EditorCore
  public weak var delegate: MarkdownEditorDelegate?
  /// device-independent scale of the drawing (the canvas's zoom)
  public var zoom: CGFloat = 1 {
    didSet { resize() }
  }
  /// the decoded image for a slot, nil while there is none (its place stays empty)
  public var image: (MarkdownImageSlot) -> CGImage? = { _ in nil }
  public var caretColor = NSColor.controlAccentColor
  public var selectionColor = NSColor.selectedTextBackgroundColor
  /// the caret's blink is off and nothing is laid out while frozen (a pinch or pan going on)
  public private(set) var frozen = false

  /// editing, or showing the static picture: no caret, no selection, no markers, keys and clicks left alone
  public var isEditing = true {
    didSet {
      guard isEditing != oldValue else { return }
      note(.editing(isEditing))
      if isEditing {
        core.select(core.selection)
      } else {
        // leaving: nothing stays selected, the static picture again
        core.select(MDSelection(core.selection.head))
        core.layout.setHead(nil)
      }
      changed()
    }
  }

  let preview = MathPreview()
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
    band.isHidden = true
    addSubview(band)
    band.onPart = { [weak self] id, v, r in self?.bandPart(id, v, r) }
    updateTrackingAreas()
    core.onLayout = { [weak self] in
      MainActor.assumeIsolated { self?.changed() }
    }
    core.onChange = { [weak self] source in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.delegate?.editor(self, didChange: source)
      }
    }
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

  public override func draw(_ dirtyRect: NSRect) {
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
    core.layout.draw(in: ctx, scale: scale, clip: clip, image: image)
    // the selection over the text: under it, a code block's or a table header's fill would hide it. Translucent, so the
    // text reads through; in the static picture too (a selection made there before editing)
    ctx.setFillColor(selectionColor.cgColor)
    for r in core.selectionRects where r.intersects(clip) { ctx.fill(r) }
    // a selected image: its ring and the two handles at its bottom corners; while one is dragged, the size it will get
    if isEditing, let box = imageBox {
      let ring =
        (resizing.map { r in
          CGRect(
            x: box.midX - r.width / 2, y: box.minY, width: r.width, height: box.height * r.width / max(1, box.width))
        } ?? box).insetBy(dx: -2, dy: -2)
      ctx.setStrokeColor(caretColor.cgColor)
      ctx.setLineWidth(2 / zoom * (window?.backingScaleFactor ?? 2) / 2)
      ctx.stroke(ring)
      for h in handles(ring) {
        ctx.setFillColor(caretColor.cgColor)
        ctx.fill(h)
      }
    }
    if isEditing, blinkOn, window?.firstResponder === self, let c = core.caretRect {
      // two device pixels wide whatever the zoom, on the caret's line
      let w = 2 / scale
      ctx.setFillColor(caretColor.cgColor)
      ctx.fill(CGRect(x: c.minX - w / 2, y: c.minY, width: w, height: c.height))
    }
    ctx.restoreGState()
  }

  private func restartBlink() {
    blink?.invalidate()
    blinkOn = true
    needsDisplay = true
    guard !frozen else { return }
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
    showPreview()
    showBand()
    guard isEditing else { return }
    if let c = core.caretRect ?? core.selectionRects.last {
      scrollToVisible(
        CGRect(x: c.minX * zoom, y: c.minY * zoom, width: max(1, c.width * zoom), height: c.height * zoom))
    }
  }

  // MARK: a code block's band

  /// the code block whose band shows: the caret's while editing, else the one the pointer is over
  private var bandBlock: EditorCore.CodeBlock? {
    if isEditing, core.marked == nil, let b = core.codeBlock(at: core.selection.head) { return b }
    return isEditing ? hovered : nil
  }

  private func showBand() {
    let m = core.layout.theme.metrics
    if let b = bandBlock {
      bandTimer?.invalidate()
      let boxes = core.rects(for: b.body.lowerBound..<max(b.body.lowerBound + 1, b.body.upperBound))
      guard let first = boxes.first else { return }
      // the code block's box: the code's padding around its lines
      let top = first.minY - CGFloat(m.codePadding[0])
      let frame = core.layout.blockFrames.first { $0.minY <= top + 1 && $0.maxY >= top } ?? .zero
      band.block = b
      band.table = nil
      let wraps = core.layout.info?.wrap?.contains(b.index) ?? false
      band.place(
        over: CGRect(x: frame.minX * zoom, y: top * zoom, width: frame.width * zoom, height: 1), zoom: zoom,
        theme: core.layout.theme,
        parts: [
          .init(id: "language", label: ((b.language?.isEmpty ?? true) ? "Plain text" : b.language!) + " ▾", left: true),
          .init(id: "copy", label: "Copy"), .init(id: "wrap", label: "Wrap", on: wraps),
        ], fill: core.layout.theme.colors.codeBlock)
      band.show(true)
      return
    }
    if isEditing, core.marked == nil, let t = MarkdownEditing.tablePlace(at: core.selection.head, in: core.document),
      let cell = t.table.rows.first?.first
    {
      bandTimer?.invalidate()
      let top =
        (core.rects(for: cell.range.lowerBound..<max(cell.range.lowerBound + 1, cell.range.upperBound)).first?
          .minY ?? 0) - CGFloat(m.cellPadding[0]) - 1
      let frame = core.layout.blockFrames.first { $0.minY <= top + 1 && $0.maxY >= top } ?? .zero
      band.block = nil
      band.table = t.block
      let align = t.column < t.table.align.count ? t.table.align[t.column] : .none
      band.place(
        over: CGRect(x: frame.minX * zoom, y: top * zoom, width: frame.width * zoom, height: 1), zoom: zoom,
        theme: core.layout.theme,
        parts: [
          .init(id: "row+", label: "+ Row", left: true), .init(id: "col+", label: "+ Column", left: true),
          .init(id: "row-", label: "− Row", left: true), .init(id: "col-", label: "− Column", left: true),
          .init(id: "left", label: "Left", on: align == .left),
          .init(id: "center", label: "Center", on: align == .center),
          .init(id: "right", label: "Right", on: align == .right),
        ], fill: core.layout.theme.colors.fill)
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
    case "row+": core.command(.addRow(below: true))
    case "row-": core.command(.deleteRow)
    case "col+": core.command(.column(.add(after: true)))
    case "col-": core.command(.column(.delete))
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
    var over: EditorCore.CodeBlock?
    if isEditing, band.isHidden || !band.frame.contains(p) {
      let c = core.layout.caret(at: at)
      if let b = core.codeBlock(at: c.offset) {
        let boxes = core.rects(for: b.body.lowerBound..<max(b.body.lowerBound + 1, b.body.upperBound))
        let pad = CGFloat(core.layout.theme.metrics.codePadding[0])
        if let f = boxes.first, let l = boxes.last, at.y >= f.minY - pad, at.y <= l.maxY + pad { over = b }
      }
    } else if band.shown, band.frame.contains(p) {
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
    preview.show((f.latex, f.display), under: r, theme: l.theme, resources: l.resources)
  }

  // MARK: the mouse

  public override func mouseDown(with e: NSEvent) {
    begin()
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
    // a press on a selected image's handle: resizing it, symmetrically about its centre (editor/image.ts); a double-click
    // on a handle gives it back its full width
    if let box = imageBox,
      let k = handles(box.insetBy(dx: -2, dy: -2)).firstIndex(where: {
        $0.insetBy(dx: -4 / zoom, dy: -4 / zoom).contains(at)
      })
    {
      if e.clickCount == 2 {
        core.setImageWidth(nil)
        changed()
        return
      }
      resizing = (box.width, at, box.width, k == 0)
      return
    }
    core.mouseDown(at: at, clicks: e.clickCount, extend: e.modifierFlags.contains(.shift))
    changed()
  }

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

  /// the two handles at a box's bottom corners, in the layout's points
  private func handles(_ box: CGRect) -> [CGRect] {
    let s = 10 / zoom
    return [
      CGRect(x: box.minX - s / 2, y: box.maxY - s / 2, width: s, height: s),
      CGRect(x: box.maxX - s / 2, y: box.maxY - s / 2, width: s, height: s),
    ]
  }

  /// a handle being dragged: the image's width as it will be (the layout's points), and where the drag began
  private var resizing: (width: CGFloat, start: CGPoint, from: CGFloat, left: Bool)?

  /// the press that started editing is still down: its drag and release are not a selection
  private var entering = false
  /// a press on the static picture, and whether it has moved into a drag (a selection) yet
  private var pressed: (at: CGPoint, dragged: Bool)?

  public override func mouseDragged(with e: NSEvent) {
    if let r = resizing {
      let p = convert(e.locationInWindow, from: nil)
      let dx = (p.x / zoom - r.start.x) * (r.left ? -1 : 1)
      // both sides move: twice the pointer's way; at least 48 points, on an 8-point grid
      let w = min(core.layout.width, max(48, ((r.from + 2 * dx) / 8).rounded() * 8))
      resizing?.width = w
      needsDisplay = true
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
    if let r = resizing {
      resizing = nil
      // one write on release: the width as a share of the body
      core.setImageWidth(Double(r.width / core.layout.width))
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
    guard core.revealPending else { return }
    settle = Timer.scheduledTimer(withTimeInterval: MarkdownTiming.revealAfterClick, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.core.settle() else { return }
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
    guard let key = e.charactersIgnoringModifiers?.lowercased(), flags.contains(.command), !flags.contains(.control),
      !flags.contains(.option)
    else { return super.performKeyEquivalent(with: e) }
    let shift = flags.contains(.shift)
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
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(t, forType: .string)
    note(.copied([("public.utf8-plain-text", t)]))
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
    guard isEditing, let t = NSPasteboard.general.string(forType: .string) else { return }
    core.paste(t)
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
