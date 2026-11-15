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
  /// the whole [[ menu for what is typed after [[ (by default the candidates above, ungrouped)
  func editor(_ e: MarkdownEditorView, refMenu query: String) -> MarkdownRefMenu
  /// a reference was picked from the [[ menu (the host remembers it as recent)
  func editor(_ e: MarkdownEditorView, pickedRef r: MarkdownRefCandidate)
  /// a picture pasted or dropped into the text: the host saves it and gives the address to write, or nil to leave it out
  func editor(_ e: MarkdownEditorView, saveImage data: Data, name: String) -> String?
  /// the / menu's Image: the host lets the user pick a picture (its bytes and file name), nil when none was picked
  func editorPicksImage(_ e: MarkdownEditorView) -> (Data, String)?
  /// whether pasted plain text is code, and in which language (the host's classifier, as main uses the board's); nil
  /// leaves it to the component's own rules
  func editor(_ e: MarkdownEditorView, classify text: String) -> MDPaste.HostCode?
  /// a plain click on a drawn [[reference]] that resolves (onRef): true when the host took it (its preview, or going
  /// there), and the caret stays where it was; false makes it an ordinary click (its source opens)
  func editor(_ e: MarkdownEditorView, activate label: String, target: String?) -> Bool
}

extension MarkdownEditorDelegate {
  public func editor(_ e: MarkdownEditorView, refCandidates query: String) -> [MarkdownRefCandidate] { [] }
  public func editor(_ e: MarkdownEditorView, refMenu query: String) -> MarkdownRefMenu {
    MarkdownRefMenu(local: editor(e, refCandidates: query))
  }
  public func editor(_ e: MarkdownEditorView, pickedRef r: MarkdownRefCandidate) {}
  public func editor(_ e: MarkdownEditorView, open url: URL) { NSWorkspace.shared.open(url) }
  public func editor(_ e: MarkdownEditorView, saveImage data: Data, name: String) -> String? { nil }
  public func editor(_ e: MarkdownEditorView, activate label: String, target: String?) -> Bool { false }
  public func editor(_ e: MarkdownEditorView, classify text: String) -> MDPaste.HostCode? { nil }
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
  /// where ⌘C, ⌘X and ⌘V go (the general pasteboard; a test's own)
  public var pasteboard = NSPasteboard.general
  /// The selection's source exactly as copied, beside the plain text and HTML: a paste in any Note reads it back as it
  /// was (ProseMirror's own slice in the web's copies), never through the HTML, which loses == marks and code lines
  public static let sourceType = NSPasteboard.PasteboardType("com.yhnocoder.codeboard.markdown")
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
  /// whether the selection toolbar is up (a host's check)
  public var toolbarShown: Bool { !toolbar.isHidden }
  let linkBox = LinkBox()
  let sizePicker = TableSizePicker()
  let noteBox = NoteBox()
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
  private func begin() {
    guard observer != nil else { return }
    eventStart = BlockLayout.cpu()
    timedEvent = NSApp.currentEvent?.timestamp
  }
  /// the input event the last begin() timed: a change started under another one (a host's, a timer's) is timed from its
  /// own start instead of from that old input
  private var timedEvent: TimeInterval?
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
    typedMenu.onTake = { [weak self] item in
      guard let self, let t = self.typedMenu.token else { return }
      self.take(item, t)
      self.changed()
    }
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
    addSubview(noteBox)
    noteBox.onWrite = { [weak self] note in
      guard let self,
        let e = MarkdownEditing.annotate(
          note, in: MDEditState(source: self.core.source, selection: self.core.selection), document: self.core.document)
      else { return }
      self.begin()
      self.core.apply(e)
      self.note(.key("handwritten note", did: note.isEmpty ? "taken off" : "written"))
      self.changed()
    }
    noteBox.onClose = { [weak self] in
      guard let self else { return }
      self.window?.makeFirstResponder(self)
    }
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
    c.willChange = { [weak self] in
      guard let self, self.observer != nil else { return }
      let now = NSApp.currentEvent?.timestamp
      if now == nil || now != self.timedEvent { self.begin() }
    }
    c.onLayout = { [weak self] in
      MainActor.assumeIsolated { self?.changed() }
    }
    c.onRelayout = { [weak self] in
      MainActor.assumeIsolated { self?.restyleChrome() }
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
      sliding["\(slot.src)#\(slot.nth)"] == nil && settled(slot.src) ? image(slot) : nil
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
    drawTableFlip(ctx)
    drawMathProblem(ctx)
    // the selection over the text: under it, a code block's or a table header's fill would hide it. Translucent, so the
    // text reads through; in the static picture too (a selection made there before editing)
    // (a selected image's source is selected underneath: no selection colour on it or its caption, also in the frame
    // before editing starts, where it once showed a tint over the picture)
    let picked = isEditing ? imageBox : nil
    if core.selectedImage == nil {
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
      let colors = core.layout.theme.colors
      for r in grips.compactMap({ $0 }) {
        let pill = CGPath(roundedRect: r, cornerWidth: 3, cornerHeight: 3, transform: nil)
        // the pointer on it: the accent, its dots in the accent's ink (.md-tgrip:hover)
        let over = gripPointer.map { r.insetBy(dx: -4, dy: -3).contains($0) } ?? false
        ctx.saveGState()
        ctx.setShadow(
          offset: CGSize(width: 0, height: 1), blur: over ? 3 : 2,
          color: over
            ? colors.accent.alpha(0.35).cg : CGColor(srgbRed: 50 / 255, green: 35 / 255, blue: 10 / 255, alpha: 0.13))
        ctx.addPath(pill)
        ctx.setFillColor((over ? colors.accent : colors.surface).cg)
        ctx.fillPath()
        ctx.restoreGState()
        if !over {
          ctx.addPath(pill)
          ctx.setStrokeColor(colors.hair.cg)
          ctx.setLineWidth(0.5)
          ctx.strokePath()
        }
        // its dots (the grip's handle)
        ctx.setFillColor(over ? colors.accentInk.alpha(0.92).cg : colors.ink3.cg)
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
    if isEditing, blinkOn, alwaysShowsCaret || window?.firstResponder === self,
      let c = core.caretRect.map(slid).map(offImage),
      tableDrag == nil
    {
      // two device pixels wide whatever the zoom, on the caret's line; a gap's caret is a short line in ink, as on main
      let w = 2 / scale
      ctx.setFillColor(c.height == 0 ? core.layout.theme.colors.ink.cg : caretColor.cgColor)
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
  /// what floats over the Note, shown again in the layout's theme (an appearance switched while a toolbar was open stayed
  /// white): nothing scrolls, the boxes' typing is kept
  private func restyleChrome() {
    let theme = core.layout.theme
    if !toolbar.isHidden { placeToolbar() }
    showHeadingChip()
    showMenu()
    showHints()
    if !hints.shown { showPreview() }
    showBand()
    if !linkBox.isHidden { linkBox.restyle(theme) }
    if !noteBox.isHidden { noteBox.restyle(theme) }
    if !findBar.isHidden { findBar.restyle(theme) }
    needsDisplay = true
  }

  // MARK: tables wider than the Note

  /// how far each table wider than the Note is scrolled across, by where its source starts
  private var tableScroll: [Int: CGFloat] = [:]

  /// the tables' scroll offsets onto the layout's pieces, the caret's table scrolled to keep it in view
  private func applyTableScroll() {
    let doc = core.document
    var kept: [Int: CGFloat] = [:]
    let caret = core.selection.isEmpty ? core.selection.head : nil
    for (i, b) in doc.blocks.enumerated() {
      guard case .table(let t) = b.kind else { continue }
      core.layout.scrollX[i] = nil
      let cells = core.layout.cellBoxes(of: t).joined().filter { $0 != .zero }
      guard let first = cells.first else { continue }
      let wide = cells.reduce(first) { $0.union($1) }.maxX + 1
      let room = max(0, wide - core.layout.width)
      var s = min(room, tableScroll[b.range.lowerBound] ?? 0)
      if let c = caret, b.range.contains(c), let r = core.layout.caretRect(MDCaret(c)) {
        // the caret in view, 12 points from either edge (r is where it is unscrolled)
        if r.minX - s < 12 { s = max(0, r.minX - 12) }
        if r.maxX - s > core.layout.width - 12 { s = min(room, r.maxX - core.layout.width + 12) }
      }
      if s > 0 { kept[b.range.lowerBound] = s }
      core.layout.scrollX[i] = s > 0 ? s : nil
    }
    tableScroll = kept
  }

  /// a sideways scroll over a table wider than the Note scrolls the table, not the card (a vertical one goes on to
  /// the page)
  public override func scrollWheel(with e: NSEvent) {
    let p = convert(e.locationInWindow, from: nil)
    let at = CGPoint(x: p.x / zoom, y: p.y / zoom)
    guard abs(e.scrollingDeltaX) > abs(e.scrollingDeltaY), let i = core.layout.block(at: at),
      case .table(let t) = core.document.blocks[i].kind
    else { return super.scrollWheel(with: e) }
    let cur = core.layout.scrollX[i] ?? 0
    let cells = core.layout.cellBoxes(of: t).joined().filter { $0 != .zero }
    guard let first = cells.first else { return super.scrollWheel(with: e) }
    let wide = cells.reduce(first) { $0.union($1) }.maxX + cur + 1
    let room = wide - core.layout.width
    guard room > 0.5 else { return super.scrollWheel(with: e) }
    let next = min(room, max(0, cur - e.scrollingDeltaX / zoom))
    tableScroll[core.document.blocks[i].range.lowerBound] = next
    core.layout.scrollX[i] = next > 0 ? next : nil
    showBand()
    needsDisplay = true
  }

  private func changed() {
    applyTableScroll()
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
      // over the part of the table the Note shows: a table wider than the Note scrolls, its band does not run off
      let shownX = max(0, g.box.minX)
      let shownW = max(0, min(g.box.maxX, core.layout.width) - shownX)
      // as many actions as that width holds, the most used first; the rest in ⋯
      let room = shownW - (8 + 7 + 8 + 27) - (6 + 14 + 6 + 8 + 40)
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
        over: CGRect(x: shownX * zoom, y: g.box.minY * zoom, width: shownW * zoom, height: 1),
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
    case "rowBelow": flipTable(.row, add: 1) { core.command(.addRow(below: true)) }
    case "rowAbove": flipTable(.row, add: 0) { core.command(.addRow(below: false)) }
    case "delRow": flipTable(.row, add: nil) { core.command(.deleteRow) }
    case "colRight": flipTable(.column, add: 1) { core.command(.column(.add(after: true))) }
    case "colLeft": flipTable(.column, add: 0) { core.command(.column(.add(after: false))) }
    case "delCol": flipTable(.column, add: nil) { core.command(.column(.delete)) }
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
    pasteboard.clearContents()
    pasteboard.setString(t, forType: .string)
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
    // over a control floating on the Note (a band, the toolbar, a menu) its own pointer, not the text's I-beam
    let chrome = subviews.contains { !$0.isHidden && $0.hitTest(convert(p, to: $0.superview)) != nil }
    if !chrome { cursor(at: p, modifiers: e.modifierFlags).set() }
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

  /// The caret beside a drawn picture is drawn a few points off its edge, not against it (imagecaret.ts); between two
  /// pictures it stays where it is
  func offImage(_ c: CGRect) -> CGRect {
    guard c.height > 0, core.selection.isEmpty else { return c }
    var left = false
    var right = false
    for slot in core.layout.images where slot.frame.minY < c.maxY && slot.frame.maxY > c.minY {
      if abs(slot.frame.minX - c.minX) < 0.5 { left = true }
      if abs(slot.frame.maxX - c.minX) < 0.5 { right = true }
    }
    if left == right { return c }
    return c.offsetBy(dx: left ? -2 : 2, dy: 0)
  }

  // MARK: a table's rows and columns changing

  enum TableAxis { case row, column }
  /// cells moving to their new places: a picture of each, where it was, where it is, and whether it comes or goes
  private var tableFlip: (cover: CGRect, pieces: [(pic: CGImage, from: CGRect, to: CGRect, fade: Int)], since: Double)?
  private var tableLink: CADisplayLink?

  /// Runs a row or column change at the caret's cell (`add`: 0 before it, 1 after it, nil the caret's one deleted) with
  /// main's flip (tableview.ts): the cells that stay slide from where they were, new ones fade in, the removed ones fade
  /// out where they were, over TABLE_SLIDE. Nothing slides in a window nobody sees. Whether the change was made
  @discardableResult
  func flipTable(_ axis: TableAxis, add: Int?, _ run: () -> Bool) -> Bool {
    let before = MarkdownEditing.tablePlace(at: core.selection.head, in: core.document)
    // each cell with its border (half a line on each side and the line itself), so the lines move with the cells
    let cells0 = (before.map { core.layout.cellBoxes(of: $0.table) } ?? []).map {
      $0.map { $0.insetBy(dx: -1, dy: -1) }
    }
    let pics0 = cells0.map { $0.map { snapshot($0) } }
    let places0 = blockPlaces()
    guard run() else { return false }
    // the table again by where it starts (the caret may be at its edge, in no cell, after a column goes)
    guard let b = before, window.map({ $0.occlusionState.contains(.visible) }) ?? true,
      let table = core.document.blocks.first(where: { $0.range.lowerBound == b.block.lowerBound }).flatMap({
        blk -> MDTable? in
        if case .table(let t) = blk.kind { return t }
        return nil
      })
    else { return true }
    let cells1 = core.layout.cellBoxes(of: table).map { $0.map { $0.insetBy(dx: -1, dy: -1) } }
    // where the line that changed is: the new one's index, or the removed one's
    let at =
      axis == .row ? (add.map { b.row + $0 == 0 ? 1 : b.row + $0 } ?? b.row) : (add.map { b.column + $0 } ?? b.column)
    // an old row's (or column's) index now: past an added one one more, past a removed one one less, the removed none
    func moved(_ k: Int) -> Int? {
      if add != nil { return k >= at ? k + 1 : k }
      return k == at ? nil : k > at ? k - 1 : k
    }
    var pieces: [(pic: CGImage, from: CGRect, to: CGRect, fade: Int)] = []
    var kept = Set<[Int]>()
    for (r, row) in cells0.enumerated() {
      for (c, from) in row.enumerated() {
        guard let pic = pics0[r][c] else { continue }
        let r1 = axis == .row ? moved(r) : r
        let c1 = axis == .column ? moved(c) : c
        if let r1, let c1, let to = cells1[safe: r1]?[safe: c1] {
          kept.insert([r1, c1])
          // a staying cell as it is now, moved from where it was: its text never squeezed by a column's new width
          pieces.append((snapshot(to) ?? pic, from, to, 0))
        } else {
          pieces.append((pic, from, from, -1))
        }
      }
    }
    for (r, row) in cells1.enumerated() {
      for (c, to) in row.enumerated() where !kept.contains([r, c]) {
        if let pic = snapshot(to) { pieces.append((pic, to, to, 1)) }
      }
    }
    // the table as it is now is covered (the cells drawn over it); what moved up under where it was stays drawn
    let all = cells1.flatMap { $0 }
    guard let first = all.first else { return true }
    tableFlip = (all.dropFirst().reduce(first) { $0.union($1) }.insetBy(dx: -1, dy: -1), pieces, core.clock())
    // the blocks under the table follow its new height, as blocks do after a move
    slideBlocks(from: places0)
    if tableLink == nil {
      let link = displayLink(target: self, selector: #selector(tableFrame(_:)))
      link.add(to: .main, forMode: .common)
      tableLink = link
    }
    needsDisplay = true
    return true
  }

  @objc private func tableFrame(_ link: CADisplayLink) {
    Self.linkTicks += 1
    needsDisplay = true
    if tableFlip == nil {
      tableLink?.invalidate()
      tableLink = nil
    }
  }

  /// the table's cells where the flip has them now, over the table as it is (drawn from the clock: right in any frame)
  private func drawTableFlip(_ ctx: CGContext) {
    guard let f = tableFlip else { return }
    let k = min(1, max(0, (core.clock() - f.since) / MarkdownTiming.tableSlide))
    guard k < 1 else {
      tableFlip = nil
      return
    }
    let e = CGFloat(MarkdownTiming.ease(k))
    ctx.saveGState()
    ctx.setFillColor(core.layout.theme.colors.surface.cg)
    ctx.fill(f.cover)
    for p in f.pieces {
      let r = CGRect(
        x: p.from.minX + (p.to.minX - p.from.minX) * e, y: p.from.minY + (p.to.minY - p.from.minY) * e,
        width: p.to.width, height: p.to.height)
      ctx.saveGState()
      ctx.setAlpha(p.fade == 0 ? 1 : p.fade > 0 ? e : 1 - e)
      ctx.translateBy(x: r.minX, y: r.maxY)
      ctx.scaleBy(x: 1, y: -1)
      ctx.draw(p.pic, in: CGRect(origin: .zero, size: r.size))
      ctx.restoreGState()
    }
    ctx.restoreGState()
  }

  /// cells flipping now: staying, coming, going (tests)
  var flippingCells: (stay: Int, come: Int, go: Int) {
    let p = tableFlip?.pieces ?? []
    return (p.filter { $0.fade == 0 }.count, p.filter { $0.fade > 0 }.count, p.filter { $0.fade < 0 }.count)
  }

  // MARK: an image address settling

  /// addresses already shown, which load at once; addresses typed while editing, since when they stood
  private var shownAddresses = Set<String>()
  private var typedAddresses: [String: Double] = [:]
  private var settleTimer: Timer?

  /// Whether an image's address may load: one shown before at once; one new while its source is being written, once it
  /// has stood for IMAGE_SETTLE (widgets.ts imageBelow), so a half-typed address is never asked for
  func settled(_ src: String) -> Bool {
    if shownAddresses.contains(src) || !isEditing || core.layout.head == nil {
      shownAddresses.insert(src)
      return true
    }
    let now = core.clock()
    guard let since = typedAddresses[src] else {
      typedAddresses[src] = now
      settleTimer?.invalidate()
      settleTimer = Timer.scheduledTimer(withTimeInterval: MarkdownTiming.imageSettle, repeats: false) {
        [weak self] _ in
        MainActor.assumeIsolated { self?.needsDisplay = true }
      }
      return false
    }
    if now - since >= MarkdownTiming.imageSettle {
      shownAddresses.insert(src)
      typedAddresses = [:]
      return true
    }
    return false
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
    // while a grip is dragged the picture is where the pointer puts it, every frame: no slide toward it (each step
    // started one, the picture lagging and jumping inside its ring)
    if resizing != nil {
      slides = [:]
      imageFrames = [:]
      framesAt = -1
      return
    }
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
      expandedRefGroups = []
      return typedMenu.hide()
    }
    let items: [MDMenuItem]
    switch t.kind {
    case .slash: items = MarkdownEditing.slashMenu(t.query)
    case .emoji: items = MarkdownEditing.emojiMenu(t.query)
    case .ref:
      items = refMenuRows(
        delegate?.editor(self, refMenu: t.query) ?? MarkdownRefMenu(local: []), typed: !t.query.isEmpty)
    }
    let caret = CGRect(x: c.minX * zoom, y: c.minY * zoom, width: 1, height: c.height * zoom)
    typedMenu.show(items, token: t, under: caret, theme: core.layout.theme)
    fit(typedMenu, to: caret)
  }

  /// groups whose "N more" was taken: all their items listed
  private var expandedRefGroups = Set<String>()

  /// The [[ menu's rows (menu.tsx): recent when nothing is typed, the local ones (under `here` when others follow), each
  /// other place's own row then its items, three while nothing is typed and the rest behind "N more in …"
  private func refMenuRows(_ m: MarkdownRefMenu, typed: Bool) -> [MDMenuItem] {
    refRows = [:]
    var rows: [MDMenuItem] = []
    var n = 0
    func add(_ r: MarkdownRefCandidate, _ style: MDMenuItem.Style) {
      let id = "ref\(n)"
      n += 1
      refRows[id] = r
      rows.append(MDMenuItem(title: r.title, hint: r.crumb ?? "", id: id, style: style))
    }
    let others = !m.groups.isEmpty || (!typed && !m.recent.isEmpty)
    if !typed, !m.recent.isEmpty {
      rows.append(MDMenuItem(title: "Recent", hint: "", id: "head-recent", style: .head))
      for r in m.recent.prefix(5) { add(r, .plain) }
    }
    if !m.local.isEmpty {
      if others { rows.append(MDMenuItem(title: m.here ?? "Here", hint: "", id: "head-here", style: .head)) }
      for r in m.local.prefix(10) { add(r, .plain) }
    }
    for g in m.groups {
      let id = "ref\(n)"
      n += 1
      refRows[id] = g.place
      rows.append(MDMenuItem(title: g.title, hint: g.note ?? "", id: id, style: .brow))
      let all = typed || expandedRefGroups.contains(g.id)
      for r in all ? g.items : Array(g.items.prefix(3)) { add(r, .child) }
      if !all, g.items.count > 3 {
        rows.append(
          MDMenuItem(title: "\(g.items.count - 3) more in \(g.title)", hint: "", id: "more:" + g.id, style: .more))
      }
    }
    return rows
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
      // "N more": the group's other items listed in place, the menu staying
      if item.id.hasPrefix("more:") {
        expandedRefGroups.insert(String(item.id.dropFirst(5)))
        showMenu()
        return
      }
      guard let r = refRows[item.id] else { break }
      delegate?.editor(self, pickedRef: r)
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
    guard band.shown else { return }
    // a part folded into ⋯ on a narrow band is pressed as its menu item would be
    bandPart(id, band, band.partRect(id)?.1 ?? .zero)
  }

  /// the handwritten note box under the selection, with the note of the annotation it is in
  func openNoteBox() {
    guard isEditing, let first = core.rects(for: core.selection.range).first else { return }
    var note = ""
    if let a = MarkdownEditing.annotation(at: core.selection.range, in: core.document),
      case .atom(.annotation(_, let n, _, _)) = a.kind
    {
      note = n
    }
    toolbar.hide()
    noteBox.show(
      note,
      under: CGRect(x: first.minX * zoom, y: first.minY * zoom, width: first.width * zoom, height: first.height * zoom),
      theme: core.layout.theme)
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
      .init(
        id: "annot", symbol: "annot", tip: "Handwritten Note",
        on: MarkdownEditing.annotation(at: core.selection.range, in: core.document) != nil),
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
    // none for a selection in code (bubble.tsx want(): not where the parent is code)
    let leaf = MarkdownEditing.context(at: s.range.lowerBound, in: core.document).leaf
    guard !s.isEmpty, !holdsToolbar, core.selectedImage == nil, core.marked == nil, tableDrag == nil, resizing == nil,
      leaf != .code, leaf != .source,
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
    let rects = core.selectionRects
    guard let first = rects.first, let last = rects.last else { return toolbar.hide() }
    let k = zoom
    let z = { (r: CGRect) in CGRect(x: r.minX * k, y: r.minY * k, width: r.width * k, height: r.height * k) }
    toolbar.show(
      toolbarButtons, over: z(first), under: z(last), in: visibleRect.intersection(bounds), avoid: lastPress,
      theme: core.layout.theme)
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
    } else if id == "annot" {
      openNoteBox()
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
    fit(hints, to: caret)
  }

  /// where the previewed formula's TeX starts in the source
  private var previewStart = 0

  /// a red wave under the character a formula's problem is at, in its open source (mathhints.ts marks it)
  private func drawMathProblem(_ ctx: CGContext) {
    guard let at = preview.problemAt else { return }
    let q = previewStart + at
    let len = (core.source as NSString).length
    guard
      let r = core.rects(for: max(0, min(q, len - 1))..<min(len, max(q, 0) + 1)).first
        ?? core.layout.caretRect(MDCaret(q))
    else { return }
    let y = r.maxY - 1
    let path = CGMutablePath()
    path.move(to: CGPoint(x: r.minX - 1, y: y))
    var x = r.minX - 1
    var up = true
    while x < max(r.maxX, r.minX + 4) + 1 {
      x += 2
      path.addLine(to: CGPoint(x: x, y: up ? y - 1.5 : y))
      up.toggle()
    }
    ctx.saveGState()
    ctx.addPath(path)
    ctx.setStrokeColor(CGColor(srgbRed: 0.85, green: 0.25, blue: 0.2, alpha: 0.9))
    ctx.setLineWidth(1)
    ctx.strokePath()
    ctx.restoreGState()
  }

  /// the preview of the formula the caret is in, under its source
  private func showPreview() {
    let l = core.layout
    // an open formula block draws its formula in place: the bubble under it only says why it does not typeset
    if isEditing, core.selection.isEmpty, let h = l.head, h == core.selection.head,
      let bi = MarkdownEditing.blockHolding(h, in: l.document), case .math = l.document.blocks[bi].kind
    {
      let b = l.document.blocks[bi]
      let body = MarkdownEditing.mathBody(b, core.source as NSString)
      let tex = (core.source as NSString).substring(with: NSRange(location: body.lowerBound, length: body.count))
      let frame = l.blockFrames[bi]
      previewStart = body.lowerBound
      preview.onFix = { [weak self] range, text in
        guard let self else { return }
        self.begin()
        let r = (body.lowerBound + range.lowerBound)..<(body.lowerBound + range.upperBound)
        self.core.apply(
          MDEdit(
            range: r, replacement: text, selection: MDSelection(r.lowerBound + (text as NSString).length),
            undo: .command))
        self.changed()
      }
      preview.show(
        (tex, true),
        under: CGRect(
          x: frame.minX * zoom + 8, y: frame.minY * zoom, width: frame.width * zoom, height: frame.height * zoom),
        theme: l.theme, resources: l.resources, caret: h - body.lowerBound, errorOnly: true)
      fit(
        preview,
        to: CGRect(x: frame.minX * zoom, y: frame.minY * zoom, width: frame.width * zoom, height: frame.height * zoom))
      return
    }
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
    previewStart = start
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
    fit(preview, to: r)
  }

  /// A popup the caret or a formula anchors, shown under `anchor`: flipped above it when under would run off what the
  /// window shows and above has more room, and kept 6 points inside it across (main's place(): flip and shift, pad 6,
  /// in the viewport)
  func fit(_ v: NSView, to anchor: CGRect) {
    guard !v.isHidden else { return }
    let shown: CGRect? =
      if let clip = enclosingScrollView?.contentView { convert(clip.bounds, from: clip) } else {
        window?.contentView.map { convert($0.bounds, from: $0) }
      }
    let b = shown ?? bounds
    guard !b.isNull, !b.isEmpty else { return }
    let pad: CGFloat = 6
    var f = v.frame
    let gap = f.minY - anchor.maxY
    let roomBelow = b.maxY - pad - anchor.maxY - gap
    let roomAbove = anchor.minY - gap - (b.minY + pad)
    if f.height > roomBelow, roomAbove > roomBelow { f.origin.y = anchor.minY - gap - f.height }
    f.origin.x = max(b.minX + pad, min(f.minX, b.maxX - pad - f.width))
    v.frame = f
  }

  // MARK: the mouse

  /// where the pointer last pressed in the view: the toolbar does not come up over it
  var lastPress: CGPoint?

  public override func mouseDown(with e: NSEvent) {
    begin()
    lastPress = convert(e.locationInWindow, from: nil)
    // a press anywhere in the Note leaves the link box: it closes at once, what it holds is written on the release
    leaveLinkBox(later: true)
    sizePicker.close()
    if !noteBox.isHidden {
      let v = noteBox.field.stringValue
      noteBox.isHidden = true
      noteBox.onWrite(v)
    }
    let p = convert(e.locationInWindow, from: nil)
    let at = CGPoint(x: p.x / zoom, y: p.y / zoom)
    defer {
      note(.mouse(.down, clicks: e.clickCount, modifiers: Self.mods(e), offset: core.selection.head))
    }
    window?.makeFirstResponder(self)
    settle?.invalidate()
    // a plain click on a drawn reference that resolves goes to the host first (session.ts / widgets.ts onRef)
    if e.clickCount == 1, e.modifierFlags.intersection([.command, .shift, .option, .control]).isEmpty,
      let (label, target) = resolvedRef(at: at), delegate?.editor(self, activate: label, target: target) == true
    {
      note(.key("click on a reference", did: "activated [[\(label)]] (taken by the host)"))
      return
    }
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

  /// the drawn [[reference]] under a point that resolves: its label and target
  func resolvedRef(at p: CGPoint) -> (String, String?)? {
    guard let r = core.layout.atom(at: p), let i = MarkdownEditing.inline(r, in: core.document),
      case .atom(.ref(let label, let target)) = i.kind,
      case .found = core.layout.resources.ref(label: label, target: target)
    else { return nil }
    // its source shown (the caret in it) is text, not the drawn reference
    if let h = core.layout.head, r.lowerBound < h, h < r.upperBound { return nil }
    return (label, target)
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
    // what floats on the Note may reach past its edges (the heading chip in the left padding, a band over a first block):
    // a press there is still its, which AppKit would not route outside the view's frame
    let p0 = convert(point, from: superview)
    if !bounds.contains(p0) {
      for v in subviews.reversed() where !v.isHidden && v.frame.contains(p0) {
        if let h = v.hitTest(p0) { return h }
      }
    }
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
    guard let head = cells.first, !head.isEmpty, !cells.joined().contains(.zero) else { return nil }
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

  /// where the pointer is, for a grip's hover
  private var gripPointer: CGPoint?

  func hoverGrips(_ at: CGPoint) {
    let was = gripPointer
    gripPointer = at
    if let g = tableGrips, let w = was,
      [
        gripHover.row.flatMap { g.rows[safe: $0] }.map(rowGrip),
        gripHover.col.flatMap { g.cols[safe: $0] }.map(colGrip),
      ]
      .compactMap({ $0 }).contains(where: {
        $0.insetBy(dx: -4, dy: -3).contains(w) != $0.insetBy(dx: -4, dy: -3).contains(at)
      })
    {
      needsDisplay = true
    }
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
      // both sides move (the picture is centred): twice the pointer's way, always from the press (widgets.ts resize); at
      // least 48 points (or what it had, when less), within 8 points of the full width the full width
      let full = core.layout.width
      var w = min(full, max(min(r.from, 48), r.from + 2 * dx))
      if abs(w - full) < 8 { w = full }
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
    // timed from the release (a drag's frames before it are their own)
    begin()
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
      if e.keyCode != 51 || shift,
        flipTable(.row, add: e.keyCode == 51 ? nil : shift ? 0 : 1, { core.command(c) })
      {
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
    let pb = pasteboard
    pb.clearContents()
    pb.setString(t, forType: .string)
    pb.setString(t, forType: Self.sourceType)
    // and as HTML, for apps that paste formatted text (the web editor's copy gives text/html too); lines of a code block
    // as preformatted code, so their line breaks hold there too
    let inCode = MarkdownEditing.context(at: core.selection.range.lowerBound, in: core.document).leaf == .code
    let html = inCode ? "<pre><code>\(Self.escapedHTML(t))</code></pre>" : MarkdownHTML.render(t)
    pb.setString(html, forType: .html)
    var types = [("public.utf8-plain-text", t), ("public.html", html), (Self.sourceType.rawValue, t)]
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
    pasteboard.clearContents()
    pasteboard.setString(t, forType: .string)
    pasteboard.setString(t, forType: Self.sourceType)
    note(.copied([("public.utf8-plain-text", t), (Self.sourceType.rawValue, t)]))
    changed()
  }
  @objc public func paste(_ sender: Any?) {
    // a picture (or picture files) on the pasteboard: saved by the host, written as images
    let pb = pasteboard
    // a Note's own copy: its source, as it was
    let own = pb.string(forType: Self.sourceType)
    if own == nil, isEditing, insertImages(from: pb) { return }
    guard isEditing else { return }
    let plainOnly = (sender as? NSMenuItem)?.action == #selector(pasteAsPlainText(_:)) || sender == nil
    var p = MDPaste(plain: own ?? pb.string(forType: .string))
    if let plain = p.plain, plain.contains("\n") { p.hostCode = delegate?.editor(self, classify: plain) }
    if !plainOnly, own == nil {
      // VS Code marks its copies with the language; HTML from elsewhere is read as Markdown
      if let vs = pb.data(forType: NSPasteboard.PasteboardType("vscode-editor-data")),
        let o = try? JSONSerialization.jsonObject(with: vs) as? [String: Any]
      {
        p.vscodeLanguage = o["mode"] as? String ?? ""
      } else if let html = pb.string(forType: .html) {
        let engines = core.layout.resources.math as? JSEngines
        let preamble = core.layout.resources.mathPreamble
        p.htmlMarkdown = HTMLMarkdown.markdown(html, shown: engines.map { e in { e.shown($0, preamble: preamble) } })
      }
    }
    guard p.plain != nil || p.htmlMarkdown != nil else { return }
    core.paste(p)
    changed()
  }
  @objc public func pasteAsPlainText(_ sender: Any?) { paste(sender) }

  static func escapedHTML(_ t: String) -> String {
    t.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
  }

  @objc public func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
    switch item.action {
    case #selector(undo(_:)): core.canUndo
    case #selector(redo(_:)): core.canRedo
    case #selector(copy(_:)): !core.selection.isEmpty
    case #selector(cut(_:)): isEditing && !core.selection.isEmpty
    case #selector(paste(_:)), #selector(pasteAsPlainText(_:)): pasteboard.string(forType: .string) != nil
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
