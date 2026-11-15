import AppKit
import CodeBoardMarkdown
import CodeBoardMarkdownUI
import CodeBoardModel
import CodeBoardNotes
import CodeUI
import TreeSitterHighlight

// The sidenote popup (web board ui/pops/notes.tsx, ui/NoteComposer.tsx, styles.css .hxpop), drawn by the app: a title
// bar with the lines' range, the title, Delete and Close; the slips (a text sidenote's Markdown drawn by the native
// component, a question with its answers and reply row, a code sidenote's head and lines), each with its tools over its
// top right while hovered; at the bottom the + or the input, which is the native Markdown editor ([[ list and all), with
// the ? that makes it a question and the switch to a code search. One popup in each, kept while what it shows changes:
// `show` again with the same key updates it in place, what is being written kept. The view is the popup and room
// around it (its shadow, an editor's menus above or below); the pointer goes through it everywhere else.

@MainActor
package final class SidenotePop: NSObject {
  /// What the popup shows (notes.tsx HighlightPop / SpotPop's props)
  package struct Shown {
    struct Answer: Equatable {
      var id: String
      var md: String
    }
    struct Ask: Equatable {
      var done: Bool
      var answers: [Answer]
    }
    /// A code sidenote's head (notes.tsx CodeHead): its symbol or file and lines, where it is, its version; Free code:
    /// the address it was pasted from
    struct Head: Equatable {
      var title: String
      var `where`: String
      var version: String
      var url: String?
    }
    enum Body: Equatable {
      /// `lines`: on lines (Always Show can show it under them); `always`: shown so
      case text(String, q: Ask?, lines: Bool, always: Bool)
      case code(Head, start: Int, lines: [String], language: String, why: String?)
    }
    /// `fixed`: in a shared card's file, shown and not changed here; `place`: it can be placed on the board as a card;
    /// `review`: its second look, the version its lines changed in or "widened"
    struct Note: Equatable {
      var id: String
      var fixed = false
      var place = false
      var review: String?
      var body: Body
    }

    package var key: String
    var theme: Theme
    /// A Highlight's lines ("35–37"), shown before the title; nil for a spot's popup
    var range: String?
    var title: String
    /// The title bar's delete: what it deletes (its label); nil when there is nothing to delete
    var remove: String?
    var notes: [Note]
    /// Opened to write a new one, the input ready (ask: as a question)
    var write = false
    var ask = false
    /// A sidenote to show (the question list went to it)
    var focus: String?
    var folder: URL
    var refs: [NoteRef]
    package var refList: RefCandidates?
  }

  /// What the user did in it
  enum Action: Equatable {
    case add(String, ask: Bool)
    /// A code sidenote of the code the input's search found
    case addCode(Segment)
    case write(String, String)
    case delete(String)
    /// Place on Board
    case place(String)
    case alwaysShow(String)
    /// Mark Reviewed
    case reviewed(String)
    case done(String, Bool)
    case answer(String, String)
    case writeAnswer(String, answer: String, String)
    /// The title bar's delete
    case remove
    case close
    case picked(group: String?, id: String)
    /// A press on a drawn [[ref]]; nil: the second press of a double-click on one
    case ref(RefPress?)
    /// A press anywhere else in it
    case elsewhere
    /// A right-click on a sidenote: its menu, at that point in the view
    case menu(String, at: CGPoint)
    /// A link clicked (a free code's address, a link in a sidenote)
    case openLink(String)
  }

  /// Code the input's search found (NoteComposer's results): its name, where it is, and the lines a sidenote of it takes
  struct Found: Equatable {
    var label: String
    var detail: String
    /// a function (ƒ), else lines of a file (▤)
    var symbol: Bool
    var segment: Segment
  }

  /// The room around the popup in the view: its shadow's on every side, and an editor's menus' above and below it
  static let margin: CGFloat = 24
  static let room: CGFloat = 300
  /// .pop.k-highlight, .pop.k-notes
  static let width: CGFloat = 460
  /// .hxpop .hh's min-height, .hxpop .tray's side and bottom padding, the bottom row's margin above
  static let headHeight: CGFloat = 34
  static let pad: CGFloat = 14
  static let bottomPad: CGFloat = 10

  package let view = PopView()
  var onAction: ((Action) -> Void)?
  /// Its size as it changes (an entry added, a code sidenote opened, the input growing)
  var onSize: ((CGSize) -> Void)?
  /// Something in it is being written, or not any more
  var onWriting: ((Bool) -> Void)?
  /// Its title bar dragged: by how much since the press (view points), and whether the drag ended
  var onDrag: ((CGSize, _ ended: Bool) -> Void)?
  /// What the input's code search finds for what is typed (the canvas's code)
  var findCode: ((String) -> [Found])?
  /// Where its editors copy to and paste from (the canvas's)
  var pasteboard = NSPasteboard.general
  /// The key of what it shows, nil when it shows nothing
  package private(set) var key: String?
  package private(set) var size = CGSize.zero
  var writing: Bool { !fields.isEmpty }

  package private(set) var shown: Shown?
  private var limit: CGFloat = 560
  let head = PopHead()
  let tray = PopTray()
  private(set) var slips: [SlipView] = []
  /// The slips being written in (their own text or an answer): kept as they are until that ends
  private var editing = Set<String>()
  private(set) var fields: [Field] = []
  /// The bottom row: the + or the input
  private(set) var bottom: NSView?

  override init() {
    super.init()
    view.pop = self
    view.alphaValue = 0
    view.panel.addSubview(head)
    view.panel.addSubview(tray)
    head.grip.onDrag = { [weak self] d, ended in self?.onDrag?(d, ended) }
  }

  /// The popup's top left in the view
  var origin: CGPoint { CGPoint(x: Self.margin, y: Self.margin + Self.room) }

  /// The view's frame (in its superview, flipped or not) for the popup's top left at `p` there
  func frame(popupAt p: CGPoint, flipped: Bool) -> CGRect {
    let o = origin
    let w = size.width + 2 * Self.margin
    let h = size.height + 2 * (Self.margin + Self.room)
    return flipped
      ? CGRect(x: p.x - o.x, y: p.y - o.y, width: w, height: h)
      : CGRect(x: p.x - o.x, y: p.y + o.y - h, width: w, height: h)
  }

  /// Shows `d` (the same key: updated in place, what is being written kept), as tall as `maxHeight` at most; its size
  @discardableResult
  func show(_ d: Shown, maxHeight: CGFloat) -> CGSize {
    view.appearance = NSAppearance(named: d.theme.dark ? .darkAqua : .aqua)
    limit = maxHeight
    if key == d.key, let was = shown, was.theme.same(as: d.theme) {
      shown = d
      head.show(d)
      wireHead()
      sync(d)
      // refs written before the [[ list came (picked from it, or typed) are drawn as they resolve now
      for f in fields { f.editor.core.relayout(f.editor.core.layout.copy(resources: resources(editing: true))) }
      relayout()
      return size
    }
    endFields()
    for s in slips { s.removeFromSuperview() }
    slips = []
    editing = []
    bottom?.removeFromSuperview()
    bottom = nil
    shown = d
    key = d.key
    view.theme = d.theme
    head.show(d)
    wireHead()
    sync(d)
    setBottom(d.write ? composer(ask: d.ask, reply: nil) : addRow())
    relayout()
    if let f = d.focus, let s = slips.first(where: { $0.note.id == f }) {
      tray.reveal(s.frame)
      s.flash()
    }
    return size
  }

  /// The input's field, or the popup, takes the keys (opened to write: at once)
  func focus() {
    guard let w = view.window else { return }
    if let c = bottom as? Composer, let t = (c.editor as NSView?) ?? c.search {
      w.makeFirstResponder(t)
    } else {
      w.makeFirstResponder(view)
    }
  }

  /// Ends what is being written (what is written is kept: added, or saved) before the popup closes
  func end() { endFields() }

  /// Lets what it shows go; out of sight
  func clear() {
    endFields()
    key = nil
    shown = nil
    view.alphaValue = 0
    for s in slips { s.removeFromSuperview() }
    slips = []
    bottom?.removeFromSuperview()
    bottom = nil
  }

  /// A text sidenote written in its slip (its menu's Edit)
  func edit(_ id: String) {
    guard let s = slips.first(where: { $0.note.id == id }) else { return }
    s.onEdit?()
  }

  func close() {
    endFields()
    onAction?(.close)
  }

  /// A press on it but on a button, a ref or a field: what is written ends, a ref's preview closes
  func pressedElsewhere() {
    endFields()
    onAction?(.elsewhere)
  }

  private func wireHead() {
    head.removeButton?.action = { [weak self] in
      self?.endFields()
      self?.onAction?(.remove)
    }
    head.closeButton.action = { [weak self] in self?.close() }
  }

  // MARK: Layout

  /// Everything placed again at the size it takes now; the canvas hears of a new size
  func relayout() {
    let w = Self.width
    let inner = w - 2 * Self.pad
    head.frame = CGRect(x: 0, y: 0, width: w, height: Self.headHeight)
    head.place()
    var y: CGFloat = 0
    for (i, s) in slips.enumerated() {
      let h = s.fit(width: inner, first: i == 0)
      s.frame = CGRect(x: 0, y: y, width: inner, height: h)
      y += h
    }
    let bh = (bottom as? Fits)?.fit(width: inner) ?? 26
    let fixed = Self.headHeight + 6 + bh + Self.bottomPad
    let room = max(40, limit - fixed)
    let shownTray = min(y, room)
    tray.frame = CGRect(x: Self.pad, y: Self.headHeight, width: inner, height: shownTray)
    tray.content(height: y)
    bottom?.frame = CGRect(x: Self.pad, y: Self.headHeight + shownTray + 6, width: inner, height: bh)
    let s = CGSize(width: w, height: fixed + shownTray)
    view.panel.frame = CGRect(origin: origin, size: s)
    view.panel.needsDisplay = true
    if s != size {
      size = s
      onSize?(s)
    }
  }

  // MARK: The slips

  /// The slips brought in step with what is shown: new ones in place, changed ones made again (not one being written
  /// in), gone ones out; the bottom row stays as it is
  private func sync(_ d: Shown) {
    let keep = Set(d.notes.map(\.id))
    for f in fields where f.owner.map({ !keep.contains($0) }) == true { finish(f, .esc) }
    var next: [SlipView] = []
    for n in d.notes {
      if let was = slips.first(where: { $0.note.id == n.id }), was.note == n || editing.contains(n.id) {
        next.append(was)
        continue
      }
      next.append(slip(n))
    }
    for s in slips where !next.contains(where: { $0 === s }) { s.removeFromSuperview() }
    slips = next
    for s in slips where s.superview == nil { tray.inner.addSubview(s) }
  }

  /// A slip made again from what is shown now (it was written in)
  private func redraw(_ id: String) {
    guard let d = shown, let i = slips.firstIndex(where: { $0.note.id == id }),
      let n = d.notes.first(where: { $0.id == id })
    else { return relayout() }
    slips[i].removeFromSuperview()
    slips[i] = slip(n)
    tray.inner.addSubview(slips[i])
    relayout()
  }

  /// A sidenote's slip (notes.tsx Slip)
  private func slip(_ n: Shown.Note) -> SlipView {
    let t = shown!.theme
    let s = SlipView(n, theme: t)
    let id = n.id
    if !n.fixed { s.onMenu = { [weak self] p in self?.onAction?(.menu(id, at: p)) } }
    let place =
      n.place ? [PopButton.tool("Place on Board", Self.icon("place"), t) { [weak self] in self?.act(.place(id)) }] : []
    if let r = n.review {
      s.review =
        r == "widened"
        ? "Its lines grew when its Highlight merged with another, check it" : "Line changed in \(r), check it"
      if !n.fixed { s.reviewButton = PopButton.text("Mark Reviewed", t) { [weak self] in self?.act(.reviewed(id)) } }
    }
    switch n.body {
    case .code(let head, let start, let lines, let language, let why):
      let tokens = (CanvasView.highlighter ?? NativeNotes.highlighter).tokens(lines: lines, language: language)
      s.code = PopCodeLines(lines: lines, tokens: tokens, start: start, theme: t)
      s.code?.onToggle = { [weak self] in self?.relayout() }
      s.head = head
      if let u = head.url { s.link = PopButton.link(u, t) { [weak self] in self?.act(.openLink(u)) } }
      s.why = why
      if !n.fixed {
        s.tools =
          place + [PopButton.tool("Delete Sidenote", Self.icon("trash"), t) { [weak self] in self?.act(.delete(id)) }]
      }
    case .text(let md, let q, let lines, let always):
      s.always = always
      let width = Self.width - 2 * Self.pad - (q == nil ? 0 : 32)
      s.body = body(
        md, width: width, edit: n.fixed ? nil : { [weak s] in s?.onEdit?() },
        toggle: n.fixed ? nil : { [weak self] text in self?.onAction?(.write(id, text)) })
      s.onEdit =
        n.fixed
        ? nil
        : { [weak self, weak s] in
          guard let self, let s else { return }
          self.write(in: s, md, width: width, owner: id) { how, v in
            let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
            if how != .esc && t != md { self.onAction?(.write(id, t)) }
          }
        }
      if !n.fixed {
        var tools: [PopButton] = []
        if let q {
          let b = PopButton.tool(q.done ? "Reopen" : "Resolve", Self.icon("check"), t) { [weak self] in
            self?.act(.done(id, !q.done))
          }
          b.on = q.done
          tools.append(b)
        }
        tools.append(PopButton.tool("Edit", Self.icon("pencil"), t) { [weak s] in s?.onEdit?() })
        if lines && q == nil {
          let a = PopButton.tool("Always Show", Self.icon("eye"), t) { [weak self] in self?.act(.alwaysShow(id)) }
          a.on = always
          tools.append(a)
        }
        tools += place
        tools.append(
          PopButton.tool(q == nil ? "Delete Sidenote" : "Delete Question", Self.icon("trash"), t) { [weak self] in
            self?.act(.delete(id))
          })
        s.tools = tools
      }
      if let q {
        s.question = q.done
        s.answers = q.answers.map { answer(n, $0) }
        if !q.done && !n.fixed {
          s.reply = PopButton.reply(t) { [weak self, weak s] in
            guard let self, let s else { return }
            self.endFields()
            self.editing.insert(id)
            let c = self.composer(ask: false, reply: id)
            s.answering = c
            self.relayout()
            self.focus(c)
          }
        }
      }
    }
    s.assemble()
    return s
  }

  /// An answer under a question (notes.tsx Answer): its text, its tools over its top right while hovered; written in
  /// place (↵ saves, Esc puts it back, written empty it goes)
  private func answer(_ n: Shown.Note, _ a: Shown.Answer) -> AnswerView {
    let t = shown!.theme
    let id = n.id
    let v = AnswerView(theme: t)
    let width = Self.width - 2 * Self.pad - 32 - 13
    v.body = body(
      a.md, width: width, edit: n.fixed ? nil : { [weak v] in v?.onEdit?() },
      toggle: n.fixed ? nil : { [weak self] text in self?.onAction?(.writeAnswer(id, answer: a.id, text)) })
    if !n.fixed {
      v.onEdit = { [weak self, weak v] in
        guard let self, let v else { return }
        self.write(in: v, a.md, width: width, owner: id) { how, text in
          let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
          if how != .esc && t != a.md { self.onAction?(.writeAnswer(id, answer: a.id, t)) }
        }
      }
      v.tools = [
        PopButton.tool("Edit Answer", Self.icon("pencil"), t) { [weak v] in v?.onEdit?() },
        PopButton.tool("Delete Answer", Self.icon("trash"), t) { [weak self] in
          self?.act(.writeAnswer(id, answer: a.id, ""))
        },
      ]
    }
    v.assemble()
    return v
  }

  /// What a button does: what is being written ends first, as a press elsewhere ends it on the page
  private func act(_ a: Action) {
    endFields()
    onAction?(a)
  }

  /// A piece of Markdown drawn as the board draws a sidenote's (.hxpop .sb.nbody); a double-click writes in it, a
  /// click on a drawn ref or link goes to the canvas, one on a task's box writes it checked or not (Md onToggle)
  private func body(
    _ md: String, width: CGFloat, edit: (() -> Void)?, toggle: ((String) -> Void)?
  ) -> MDBody {
    let b = MDBody(layout: layout(md, width: width, editing: false), folder: shown!.folder, dark: shown!.theme.dark)
    b.onDouble = edit
    if let toggle { b.onTask = { k in MarkdownSourceOps.toggleTask(md, nth: k).map(toggle) } }
    b.onRef = { [weak self, weak b] r in
      guard let self, let b else { return }
      guard let r else {
        self.onAction?(.ref(nil))
        return
      }
      self.onAction?(
        .ref(
          RefPress(
            ref: r.label, target: r.target, rect: b.convert(r.rect, to: self.view), go: r.go, writing: false)))
    }
    b.onLink = { [weak self] u in self?.act(.openLink(u)) }
    return b
  }

  // MARK: Writing

  /// How a field ended: ↵, Esc, or from outside (the popup closing, a press elsewhere in it)
  enum How { case enter, esc, done }

  final class Field {
    let editor: MarkdownEditorView
    /// The sidenote whose slip it is in (nil: the bottom row's input)
    let owner: String?
    let end: (How, String) -> Void
    init(_ editor: MarkdownEditorView, owner: String?, end: @escaping (How, String) -> Void) {
      self.editor = editor
      self.owner = owner
      self.end = end
    }
  }

  /// A slip's (or an answer's) text written in place, in the Notes' editor where its text was
  private func write(
    in host: Writable, _ md: String, width: CGFloat, owner: String, end: @escaping (How, String) -> Void
  ) {
    endFields()
    editing.insert(owner)
    let e = editor(md, width: width)
    open(e, owner: owner) { [weak self] how, v in
      self?.editing.remove(owner)
      end(how, v)
      self?.redraw(owner)
    }
    host.writing = e
    relayout()
    view.window?.makeFirstResponder(e)
  }

  /// The Notes' editor as a sidenote's field (NoteComposer.tsx SnField): its caret at the end
  private func editor(_ md: String, width: CGFloat) -> MarkdownEditorView {
    let e = MarkdownEditorView(layout: layout(md, width: width, editing: true), caret: (md as NSString).length)
    e.delegate = self
    e.acceptsFirstClick = true
    e.wantsLayer = true
    // its [[ and formula lists over the whole popup: the tray cuts what hangs out of it while it scrolls
    e.floatHost = view
    e.selectionColor = shown!.theme.textSelection
    e.pasteboard = pasteboard
    let (folder, dark) = (shown!.folder, shown!.theme.dark)
    e.image = { [weak e] slot in
      NativeNotes.image(
        slot, folder: folder, pictures: CanvasView.pictures, scale: (e?.window?.backingScaleFactor ?? 2), dark: dark,
        images: CanvasView.sharedImages)
    }
    e.onReturn = { [weak self, weak e] in
      guard let self, let e, let f = self.fields.first(where: { $0.editor === e }) else { return false }
      self.finish(f, .enter)
      return true
    }
    return e
  }

  private func open(_ e: MarkdownEditorView, owner: String?, end: @escaping (How, String) -> Void) {
    fields.append(Field(e, owner: owner, end: end))
    if fields.count == 1 { onWriting?(true) }
  }

  /// A field ended `how`: its view taken away, what it holds handed on; the popup takes the keys if it had them
  func finish(_ f: Field, _ how: How) {
    guard let i = fields.firstIndex(where: { $0 === f }) else { return }
    fields.remove(at: i)
    let had = view.window?.firstResponder === f.editor
    let v = f.editor.source
    // the window first: a view that has the keys taken out of it leaves them to the window, not the canvas
    if had { view.window?.makeFirstResponder(view) }
    f.editor.removeFromSuperview()
    f.end(how, v)
    if fields.isEmpty { onWriting?(false) }
    relayout()
  }

  func endFields() {
    for f in fields.reversed() { finish(f, .done) }
  }

  private func setBottom(_ v: NSView) {
    bottom?.removeFromSuperview()
    bottom = v
    view.panel.addSubview(v)
  }

  /// The + (Add Sidenote)
  private func addRow() -> PopButton {
    PopButton.add(shown!.theme) { [weak self] in
      guard let self else { return }
      self.endFields()
      let c = self.composer(ask: false, reply: nil)
      self.setBottom(c)
      self.relayout()
      self.focus(c)
    }
  }

  private func focus(_ c: Composer) {
    view.window?.makeFirstResponder((c.editor as NSView?) ?? c.search)
  }

  /// The input for a new sidenote (NoteComposer.tsx), or (reply) for an answer to that question: ↵ adds what is written
  /// and the next one is written in a new input (a question asked, an answer given: back to the + or the reply row);
  /// Esc, a press elsewhere or the popup closing add what is written; nothing written, it just goes
  private func composer(ask: Bool, reply: String?) -> Composer {
    let c = Composer(theme: shown!.theme, replyTo: reply, ask: ask && reply == nil)
    c.onAsk = { [weak self, weak c] in
      guard let c else { return }
      if c.mode == .code { self?.textMode(c) }
      c.asking.toggle()
      c.needsDisplay = true
      self?.relayout()
    }
    c.onCode = { [weak self, weak c] in
      guard let self, let c else { return }
      if c.mode == .code { self.textMode(c) } else { self.codeMode(c) }
    }
    textMode(c)
    return c
  }

  private func textMode(_ c: Composer) {
    c.search?.removeFromSuperview()
    c.search = nil
    c.found = []
    c.mode = .text
    let e = editor("", width: c.textWidth(Self.width - 2 * Self.pad))
    c.editor = e
    c.addSubview(e)
    open(e, owner: c.replyTo) { [weak self, weak c] how, v in
      guard let self, let c else { return }
      c.editor = nil
      // turned into the code search: nothing is added
      guard c.mode == .text else { return }
      let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
      if let q = c.replyTo {
        if !t.isEmpty { self.onAction?(.answer(q, t)) }
        self.editing.remove(q)
        self.redraw(q)
        return
      }
      if !t.isEmpty { self.onAction?(.add(t, ask: c.asking)) }
      guard self.bottom === c else { return }
      let next = how == .enter && !t.isEmpty && !c.asking
      let row: NSView = next ? self.composer(ask: false, reply: nil) : self.addRow()
      self.setBottom(row)
      if let n = row as? Composer { DispatchQueue.main.async { self.focus(n) } }
    }
    relayout()
  }

  private func codeMode(_ c: Composer) {
    c.mode = .code
    c.asking = false
    if let f = fields.first(where: { $0.editor === c.editor }) { finish(f, .done) }
    let s = NSTextField()
    s.isBordered = false
    s.drawsBackground = false
    s.focusRingType = .none
    s.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    s.textColor = NSColor(cgColor: c.theme.ink)
    s.setAccessibilityLabel("Search code")
    s.delegate = self
    c.search = s
    c.addSubview(s)
    relayout()
    view.window?.makeFirstResponder(s)
  }

  /// The search's chosen result added as a code sidenote; the input goes on as a new one (NoteComposer pick)
  fileprivate func pick(_ c: Composer, _ i: Int) {
    guard c.found.indices.contains(i) else { return }
    onAction?(.addCode(c.found[i].segment))
    c.search?.stringValue = ""
    c.found = []
    textMode(c)
    focus(c)
  }

  fileprivate func searched(_ c: Composer) {
    let q = c.search?.stringValue.trimmingCharacters(in: .whitespaces) ?? ""
    c.found = q.isEmpty ? [] : Array((findCode?(q) ?? []).prefix(8))
    c.chosen = 0
    c.results = c.found.enumerated().map { i, f in
      PopButton.found(f, c.theme) { [weak self, weak c] in
        guard let c else { return }
        self?.pick(c, i)
      }
    }
    relayout()
  }

  fileprivate func leaveSearch(_ c: Composer) {
    guard bottom === c else { return }
    setBottom(addRow())
    relayout()
    view.window?.makeFirstResponder(view)
  }

  // MARK: Markdown

  /// The formula engines, made the first time a sidenote has a formula or one is written
  static var math: (any MathTypesetter)? = {
    try? MarkdownAssets.engines()
  }()

  /// What a sidenote's Markdown is laid out with: the refs it has, and those the [[ list offers (one picked is drawn as
  /// what it points at at once)
  private func resources(editing: Bool, _ md: String = "") -> NativeNotes.Resources {
    let d = shown!
    let refs = d.refs + (d.refList?.refs ?? [])
    let math = editing || NativeNotes.needsEngines(md) ? Self.math : nil
    return NativeNotes.Resources(
      folder: d.folder, pictures: CanvasView.pictures, refs: refs, math: math, dark: d.theme.dark)
  }

  private func layout(_ md: String, width: CGFloat, editing: Bool) -> BlockLayout {
    let t = shown!.theme
    let card = MarkdownLooks.card(.sidenote, look: t.id.rawValue, dark: t.dark)
    return BlockLayout(
      MarkdownDocument(md), width: width, theme: card.theme, layout: nil, resources: resources(editing: editing, md))
  }

  // MARK: Icons

  /// The board's icons the popup shows (ui/icons.tsx)
  static func icon(_ name: String) -> CGPath {
    SVGPath.parse(
      [
        "plus": "M8 3v10M3 8h10",
        "close": "M12 4 4 12M4 4l8 8",
        "check": "M13 4 6 11 3 8",
        "pencil": "M11 2l3 3-8.5 8.5L2 14l.5-3.5zM9 4l3 3",
        "eye": "M1.5 8a6.73 6.73 0 0 1 13 0 6.73 6.73 0 0 1-13 0zM10 8A2 2 0 1 1 6 8A2 2 0 1 1 10 8Z",
        "place":
          "M2.5 3H13.5A.5 .5 0 0 1 14 3.5V12.5A.5 .5 0 0 1 13.5 13H2.5A.5 .5 0 0 1 2 12.5V3.5A.5 .5 0 0 1 2.5 3zM5 7h6M5 10h4",
        "trash":
          "M2 4h12M6 7v4M10 7v4M13 4V13.5A.5 .5 0 0 1 12.5 14H3.5A.5 .5 0 0 1 3 13.5V4M6 4V2.5A.5 .5 0 0 1 6.5 2H9.5A.5 .5 0 0 1 10 2.5V4",
        "reply": "M10 7l3 3-3 3M3 3v4a3 3 0 0 0 3 3h7",
        "question": "M14 8A6 6 0 1 1 2 8A6 6 0 1 1 14 8ZM6.5 6.5a1.5 1.5 0 0 1 3 0c0 1-1.5 1.5-1.5 2.5M8 11.5v.5",
        "code": "M10.5 11.5 14 8l-3.5-3.5M5.5 4.5 2 8l3.5 3.5",
        "search": "M11.5 7A4.5 4.5 0 1 1 2.5 7A4.5 4.5 0 1 1 11.5 7ZM10.2 10.2 14 14",
      ][name] ?? "")
  }

  // MARK: Tests

  /// The labels of the buttons in the title bar, a slip's tools, or the whole popup's (tests)
  func labels(in note: String? = nil) -> [String] {
    if let note { return slips.first { $0.note.id == note }?.tools.map(\.label) ?? [] }
    return head.buttons.map(\.label)
  }

  /// Presses the first button labelled so, in a sidenote's slip (its answers, review line and head too) or anywhere
  /// (tests and the review sheets); false when there is none
  @discardableResult
  package func press(_ label: String, in note: String? = nil) -> Bool {
    let roots: [NSView] = note.map { n in slips.filter { $0.note.id == n } } ?? [view]
    for r in roots {
      if let b = PopButton.find(label, in: r) {
        b.action()
        return true
      }
    }
    return false
  }

  /// A long code sidenote opened all, or cut again, as a click on it does (the review sheets)
  package func openCode(_ note: String) {
    slips.first { $0.note.id == note }?.code?.toggle()
  }

  /// The field that has the keys, else the bottom row's (tests and the review sheets)
  package var field: MarkdownEditorView? {
    fields.first { view.window?.firstResponder === $0.editor }?.editor ?? (bottom as? Composer)?.editor
  }
}

extension SidenotePop: MarkdownEditorDelegate {
  package func editor(_ e: MarkdownEditorView, didChange source: String) {}

  package func editor(_ e: MarkdownEditorView, didResize size: CGSize) { relayout() }

  /// Esc: the field ends so (a list open in it took the Esc before this)
  package func editorWantsToEnd(_ e: MarkdownEditorView) {
    guard let f = fields.first(where: { $0.editor === e }) else { return }
    finish(f, .esc)
  }

  package func editorDidBegin(_ e: MarkdownEditorView) {}

  package func editor(_ e: MarkdownEditorView, open url: URL) { onAction?(.openLink(url.absoluteString)) }

  /// A click on a drawn ref in a field: to the canvas as one in a sidenote's text, the caret staying (refclick.ts)
  package func editor(_ e: MarkdownEditorView, activate label: String, target: String?) -> Bool {
    let r = e.core.layout.drawnRefs.first { $0.label == label && $0.target == target }?.rect ?? .zero
    let z = e.zoom
    let box = e.convert(CGRect(x: r.minX * z, y: r.minY * z, width: r.width * z, height: r.height * z), to: view)
    onAction?(.ref(RefPress(ref: label, target: target, rect: box, writing: true)))
    return true
  }

  /// The second press of a double-click on one: its source opens in the field, the first click's going dropped
  package func editor(_ e: MarkdownEditorView, doubleClickedRef label: String, target: String?) {
    onAction?(.ref(nil))
  }

  /// The [[ list (md/load.ts editorOpts' refs): this board's titled cards and Sections, then each other board's
  package func editor(_ e: MarkdownEditorView, refMenu query: String) -> MarkdownRefMenu {
    Self.refMenu(shown?.refList, query: query)
  }

  package func editor(_ e: MarkdownEditorView, pickedRef r: MarkdownRefCandidate) {
    guard let p = Self.picked(r) else { return }
    onAction?(.picked(group: p.group, id: p.id))
  }

  /// The card a row of the [[ list is, and the board it is on when another (its target: card, or board/card)
  static func picked(_ r: MarkdownRefCandidate) -> (group: String?, id: String)? {
    guard let t = r.target else { return nil }
    let parts = t.split(separator: "/", maxSplits: 1).map(String.init)
    return parts.count == 2 ? (parts[0], parts[1]) : (nil, t)
  }

  /// The [[ list for what is typed after [[: what the canvas gathered, the rows whose title holds it.
  /// ponytail: a plain substring match, the web list's fuzzy order when that is missed
  static func refMenu(_ list: RefCandidates?, query: String) -> MarkdownRefMenu {
    guard let list else { return MarkdownRefMenu(local: []) }
    let q = query.lowercased()
    func fits(_ t: String) -> Bool { q.isEmpty || t.lowercased().contains(q) }
    func row(_ i: RefCandidates.Item) -> MarkdownRefCandidate {
      MarkdownRefCandidate(label: i.label ?? i.title, target: i.target, title: i.title, crumb: i.crumb)
    }
    let groups = list.groups.compactMap { g -> MarkdownRefGroup? in
      let items = g.items.filter { fits($0.title) }.map(row)
      guard !items.isEmpty || fits(g.title) else { return nil }
      return MarkdownRefGroup(
        id: g.id, title: g.title, place: MarkdownRefCandidate(label: g.label, target: g.target, title: g.title),
        note: g.note, items: items)
    }
    let recent = list.recent.compactMap { p in
      (p.group.map { g in list.groups.first { $0.id == g }?.items ?? [] } ?? list.items).first { $0.id == p.id }.map(
        row)
    }
    return MarkdownRefMenu(
      recent: recent, here: "This board", local: list.items.filter { fits($0.title) }.map(row), groups: groups,
      foot: list.foot)
  }
}

extension SidenotePop: NSTextFieldDelegate {
  private func composer(of t: NSControl) -> Composer? { (bottom as? Composer).flatMap { $0.search === t ? $0 : nil } }

  package func controlTextDidChange(_ n: Notification) {
    guard let t = n.object as? NSTextField, let c = composer(of: t) else { return }
    searched(c)
  }

  /// ↑ ↓ choose a result, ↵ adds it, Esc leaves the search (NoteComposer's input)
  package func control(_ control: NSControl, textView: NSTextView, doCommandBy s: Selector) -> Bool {
    guard let c = composer(of: control) else { return false }
    switch s {
    case #selector(NSResponder.moveUp(_:)), #selector(NSResponder.moveDown(_:)):
      guard !c.found.isEmpty else { return true }
      let d = s == #selector(NSResponder.moveUp(_:)) ? -1 : 1
      c.chosen = (c.chosen + d + c.found.count) % c.found.count
      for (i, b) in c.results.enumerated() { b.on = i == c.chosen }
      return true
    case #selector(NSResponder.insertNewline(_:)):
      pick(c, c.chosen)
      return true
    case #selector(NSResponder.cancelOperation(_:)):
      leaveSearch(c)
      return true
    default: return false
    }
  }
}

extension RefCandidates {
  /// What each candidate points at, as refs: one picked from the list is drawn as found at once
  var refs: [NoteRef] {
    var out: [NoteRef] = []
    for i in items { out.append(NoteRef(label: i.label ?? i.title, target: i.target, hit: i.hit)) }
    for g in groups {
      out.append(NoteRef(label: g.label, target: g.target, hit: g.hit))
      for i in g.items { out.append(NoteRef(label: i.label ?? i.title, target: i.target, hit: i.hit)) }
    }
    return out
  }
}

/// Something laid out at a width: its height
@MainActor protocol Fits: NSView {
  func fit(width: CGFloat) -> CGFloat
}

/// Something with a text that can be written in place: the field shown in its text's place
@MainActor protocol Writable: AnyObject {
  var writing: MarkdownEditorView? { get set }
}

// MARK: - Views

/// The popup's view: the popup (`panel`) and room around it; the pointer goes through it but on the popup and an
/// editor's menus, which may hang past the popup's edge. Esc closes it when nothing in it took the key
package final class PopView: NSView {
  weak var pop: SidenotePop?
  let panel = PopPanel()
  var theme = Theme.warmInk {
    didSet { panel.theme = theme }
  }
  /// Esc: true when something over the canvas took it (a ref's preview closed), and the popup stays
  var escape: (() -> Bool)?
  /// The title bar but its buttons, which takes the drag (tests)
  package var grip: GripView { pop!.head.grip }
  /// The popup in the view (tests)
  package var popRect: CGRect { panel.frame }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    addSubview(panel)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  package override var isFlipped: Bool { true }
  package override var acceptsFirstResponder: Bool { true }
  package override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  package override func hitTest(_ point: NSPoint) -> NSView? {
    guard alphaValue > 0, let sv = superview else { return nil }
    let p = convert(point, from: sv)
    // what floats off a field (the [[ list, the toolbar) is its, wherever it hangs
    for f in pop?.fields ?? [] {
      if let s = f.editor.superview, let h = f.editor.hitTest(s.convert(p, from: self)) { return h }
    }
    return panel.frame.contains(p) ? super.hitTest(point) : nil
  }

  package override func keyDown(with e: NSEvent) {
    guard e.keyCode == 53 else { return super.keyDown(with: e) }
    if escape?() == true { return }
    pop?.close()
  }

  package override func cancelOperation(_ sender: Any?) {
    if escape?() == true { return }
    pop?.close()
  }
}

/// The popup itself: its surface on its shadow, a faint edge in the accent (.pop.k-highlight's box-shadow)
final class PopPanel: NSView {
  var theme = Theme.warmInk {
    didSet { restyle() }
  }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    restyle()
  }

  /// a field's [[ list hangs out of it (AppKit clips a view whose layer has rounded corners)
  override var clipsToBounds: Bool {
    get { false }
    set {}
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  private func restyle() {
    guard let l = layer else { return }
    l.backgroundColor = theme.surface
    l.cornerRadius = 14
    l.borderColor = theme.accent.copy(alpha: 0.22)
    l.borderWidth = 1
    l.shadowColor = CGColor(gray: 0, alpha: 1)
    l.shadowOpacity = theme.dark ? 0.5 : 0.22
    l.shadowRadius = 16
    l.shadowOffset = CGSize(width: 0, height: -10)
    l.masksToBounds = false
  }

  /// A press on the popup's own surface ends what is being written in it, as a click elsewhere blurs a field
  override func mouseDown(with e: NSEvent) { popOf(self)?.pressedElsewhere() }
}

/// The title bar (.hxpop .hh): the lines' range in a pill, the title, the delete when there is something to delete,
/// Close; the rest of it takes the drag
final class PopHead: NSView {
  private var range: String?
  private var title = ""
  private var theme = Theme.warmInk
  private(set) var removeButton: PopButton?
  private(set) var closeButton = PopButton.head("Close", SidenotePop.icon("close"), 13, Theme.warmInk) {}
  let grip = GripView()
  var buttons: [PopButton] { (removeButton.map { [$0] } ?? []) + [closeButton] }

  override var isFlipped: Bool { true }

  func show(_ d: SidenotePop.Shown) {
    range = d.range
    title = d.title
    theme = d.theme
    for b in buttons { b.removeFromSuperview() }
    removeButton = d.remove.map { PopButton.head($0, SidenotePop.icon("trash"), 14, d.theme) {} }
    closeButton = PopButton.head("Close", SidenotePop.icon("close"), 13, d.theme) {}
    for b in buttons { addSubview(b) }
    if grip.superview == nil { addSubview(grip) }
    needsDisplay = true
  }

  /// padding 5 10 3 14, its buttons 26 square at the right, 8 apart
  func place() {
    var x = bounds.width - 10
    for b in buttons.reversed() {
      x -= 26
      b.frame = CGRect(x: x, y: 5, width: 26, height: 26)
      x -= 8
    }
    grip.frame = CGRect(x: 0, y: 0, width: x + 8, height: bounds.height)
  }

  override func draw(_ dirty: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let t = theme
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    let mid: CGFloat = 18
    var x: CGFloat = 14
    let limit = (buttons.first?.frame.minX ?? bounds.width - 10) - 8
    if let r = range {
      // .rng in the band look: 600 11 mono in the accent, on a pill of it at 12 %
      let f = Font.mono(11, .semibold)
      let w = min(Drawing.width(r, f), limit - x - 14)
      let pill = CGRect(x: x, y: mid - 8.5, width: w + 14, height: 17)
      ctx.addPath(CGPath(roundedRect: pill, cornerWidth: 8.5, cornerHeight: 8.5, transform: nil))
      ctx.setFillColor(t.accent.copy(alpha: 0.12)!)
      ctx.fillPath()
      Drawing.text(ctx, r, f, t.accent, x: x + 7, midY: mid, width: w)
      x += w + 14 + 8
    }
    // .ttl: 600 11.5 mono in --ink-2, cut with an ellipsis
    if !title.isEmpty {
      Drawing.text(ctx, title, Font.mono(11.5, .semibold), t.ink2, x: x, midY: mid, width: limit - x)
    }
  }
}

/// The title bar but its buttons: a press and drag moves the popup (the canvas moves the view)
package final class GripView: NSView {
  var onDrag: ((CGSize, Bool) -> Void)?
  private var from: CGPoint?

  package override var isFlipped: Bool { true }
  package override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  package override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }

  package override func mouseDown(with e: NSEvent) {
    popOf(self)?.endFields()
    from = e.locationInWindow
  }

  package override func mouseDragged(with e: NSEvent) {
    guard let f = from else { return }
    let p = e.locationInWindow
    onDrag?(CGSize(width: p.x - f.x, height: f.y - p.y), false)
  }

  package override func mouseUp(with e: NSEvent) {
    guard let f = from else { return }
    from = nil
    let p = e.locationInWindow
    onDrag?(CGSize(width: p.x - f.x, height: f.y - p.y), true)
  }
}

/// The slips under the title bar, scrolled by the wheel when they are more than the popup's height holds
final class PopTray: NSView {
  let inner = FlippedView()
  private var height: CGFloat = 0
  private var scrolled: CGFloat = 0

  override init(frame: NSRect) {
    super.init(frame: frame)
    addSubview(inner)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }

  /// Clipped only while it scrolls: a field's toolbar hangs out of the popup otherwise (its [[ and formula lists are
  /// the popup's own, MarkdownEditorView.floatHost, and hang out of it either way)
  func content(height h: CGFloat) {
    height = h
    clipsToBounds = h > bounds.height + 0.5
    scrolled = max(0, min(scrolled, h - bounds.height))
    inner.frame = CGRect(x: 0, y: -scrolled, width: bounds.width, height: h)
  }

  func reveal(_ r: CGRect) {
    if r.minY < scrolled {
      scrolled = r.minY
    } else if r.maxY > scrolled + bounds.height {
      scrolled = r.maxY - bounds.height
    }
    content(height: height)
  }

  override func scrollWheel(with e: NSEvent) {
    guard height > bounds.height else { return }
    scrolled = max(0, min(scrolled - e.scrollingDeltaY, height - bounds.height))
    content(height: height)
  }
}

/// A sidenote's slip (notes.tsx Slip): its body (Markdown, or a code sidenote's head and lines and why), its second
/// look's line, a question's mark, answers and reply row; its tools over its top right while hovered
final class SlipView: NSView, Writable {
  let note: SidenotePop.Shown.Note
  let theme: Theme
  var tools: [PopButton] = []
  var body: MDBody?
  var code: PopCodeLines?
  var head: SidenotePop.Shown.Head?
  var link: PopButton?
  var why: String?
  var review: String?
  var reviewButton: PopButton?
  var always = false
  /// A question: resolved or open
  var question: Bool?
  var answers: [AnswerView] = []
  var reply: PopButton?
  /// The input of an answer, in the reply row's place
  var answering: Composer? {
    didSet {
      oldValue?.removeFromSuperview()
      if let a = answering { addSubview(a) }
    }
  }
  var writing: MarkdownEditorView? {
    didSet {
      oldValue?.removeFromSuperview()
      if let w = writing { addSubview(w) }
    }
  }
  var onEdit: (() -> Void)?
  var onMenu: ((CGPoint) -> Void)?
  /// its tools (internal: tests read where they are)
  let bar = ToolBar()
  private var hovered = false {
    didSet { bar.isHidden = !hovered || writing != nil }
  }
  private var first = true
  /// A question's own text (.qbody): its tools show over it alone, not over its answers
  private var qbody: CGRect?

  init(_ n: SidenotePop.Shown.Note, theme: Theme) {
    note = n
    self.theme = theme
    super.init(frame: .zero)
    bar.theme = theme
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  /// Its parts put in
  func assemble() {
    for v in [body, code, link, reviewButton, reply].compactMap({ $0 }) as [NSView] { addSubview(v) }
    for a in answers { addSubview(a) }
    bar.buttons = tools
    bar.isHidden = true
    addSubview(bar)
  }

  /// Its parts placed at that width: padding 10 0 11, 3 between (a question: 32 on its left, 6 between)
  func fit(width w: CGFloat, first: Bool) -> CGFloat {
    self.first = first
    let left: CGFloat = question == nil ? 0 : 32
    let gap: CGFloat = question == nil ? 3 : 6
    var y: CGFloat = 10
    if head != nil {
      link?.frame = CGRect(x: linkX, y: y, width: min(linkWidth, max(0, w - linkX - 60)), height: 16)
      y += 16 + gap
    }
    if let code {
      let h = code.fit(width: w)
      code.frame = CGRect(x: 0, y: y, width: w, height: h)
      y += h + gap
    }
    if why != nil { y += 18 + 8 + gap }
    if let writing {
      writing.setFrameOrigin(CGPoint(x: left, y: y))
      y += max(writing.frame.height, 20) + gap
    } else if let body {
      body.frame = CGRect(x: left, y: y, width: body.layout.width, height: max(body.layout.height, 20))
      y += body.frame.height + gap
    }
    qbody =
      question == nil
      ? nil : CGRect(x: left, y: body?.frame.minY ?? 10, width: w - left, height: body?.frame.height ?? 20)
    if review != nil {
      let h: CGFloat = 28
      reviewButton?.frame = CGRect(x: w - 10 - reviewWidth, y: y, width: reviewWidth, height: h)
      y += h + gap
    }
    for a in answers {
      let h = a.fit(width: w - left - 2)
      a.frame = CGRect(x: left + 2, y: y, width: w - left - 2, height: h)
      y += h + gap
    }
    if let answering {
      let h = answering.fit(width: w - left - 2)
      answering.frame = CGRect(x: left + 2, y: y, width: w - left - 2, height: h)
      y += h + gap
    } else if let reply {
      reply.frame = CGRect(x: left + 2, y: y, width: w - left - 2, height: 22)
      y += 22 + gap
    }
    let h = y - gap + 11
    bar.place()
    // over the slip's top right (.kt: 4 in); a question's over its own text's, 4 above and 6 past it (.qbody > .kt)
    bar.frame.origin =
      qbody.map { CGPoint(x: $0.maxX + 6 - bar.frame.width, y: $0.minY - 4) }
      ?? CGPoint(x: w - 4 - bar.frame.width, y: 4)
    bar.isHidden = !hovered || writing != nil || tools.isEmpty
    needsDisplay = true
    updateTrackingAreas()
    return h
  }

  private var reviewWidth: CGFloat { Drawing.width("Mark Reviewed", Font(NSFont.systemFont(ofSize: 12.5))) + 20 }
  private var headFont: Font { Font.mono(11, .regular) }
  private var linkX: CGFloat {
    guard let head else { return 0 }
    var x = Drawing.width(head.title, Font.mono(11, .medium)) + 6
    if !head.where.isEmpty { x += Drawing.width("· \(head.where)", headFont) + 6 }
    return x
  }
  private var linkWidth: CGFloat { link.map { Drawing.width($0.label, headFont) } ?? 0 }

  override func draw(_ dirty: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let t = theme
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    // the slips are rows, not boxes: a hairline between two
    if !first {
      ctx.setFillColor(t.line)
      ctx.fill(CGRect(x: 0, y: 0, width: bounds.width, height: 1))
    }
    if let done = question {
      // open: a warm tint and its ring; the mark at its left (.qm)
      if !done {
        ctx.setFillColor(Self.mix(t.ask, 0.09, over: t.surface))
        ctx.fill(bounds)
        ctx.setStrokeColor(t.ask.copy(alpha: 0.34)!)
        ctx.setLineWidth(1)
        ctx.stroke(bounds.insetBy(dx: 0.5, dy: 0.5))
      }
      let m = CGRect(x: 8, y: 11.5, width: 16, height: 16)
      ctx.addEllipse(in: m)
      if done {
        ctx.setStrokeColor(t.hair)
        ctx.strokePath()
        Icons.stroke(
          SidenotePop.icon("check"), scale: 11 / 16, at: CGPoint(x: m.minX + 2.5, y: m.minY + 2.5), color: t.ink3,
          in: ctx)
      } else {
        ctx.setFillColor(t.ask)
        ctx.fillPath()
        let f = Font(NSFont.systemFont(ofSize: 11, weight: .bold))
        Drawing.text(ctx, "?", f, t.askInk, x: m.midX - Drawing.width("?", f) / 2, midY: m.midY, width: 16)
      }
    }
    if let head {
      // .sn-head: 11 mono in --ink-3, its name in --ink at 500; the version at the right
      var x: CGFloat = 0
      let mid: CGFloat = 18
      Drawing.text(ctx, head.title, Font.mono(11, .medium), t.ink, x: x, midY: mid, width: bounds.width - 60)
      x += Drawing.width(head.title, Font.mono(11, .medium)) + 6
      if !head.where.isEmpty {
        Drawing.text(ctx, "· \(head.where)", headFont, t.ink3, x: x, midY: mid, width: bounds.width - 60 - x)
      }
      if !head.version.isEmpty {
        let f = Font.mono(10, .regular)
        let w = Drawing.width(head.version, f) + 10
        let r = CGRect(x: bounds.width - w, y: mid - 7.5, width: w, height: 15)
        ctx.addPath(CGPath(roundedRect: r, cornerWidth: 7.5, cornerHeight: 7.5, transform: nil))
        ctx.setFillColor(t.hlrow)
        ctx.fillPath()
        Drawing.text(ctx, head.version, f, t.ink2, x: r.minX + 5, midY: mid, width: w)
      }
    }
    if let why, let code {
      // .sn-why: 12 italic in --ink-2, 12 in
      let f = Font(NSFont.systemFont(ofSize: 12)).italic
      Drawing.text(ctx, why, f, t.ink2, x: 12, midY: code.frame.maxY + 3 + 9, width: bounds.width - 24)
    }
    if let review {
      // .sn-why.review: in the warning colour, Mark Reviewed at its end
      let y = reviewButton?.frame.midY ?? (bounds.height - 25)
      Drawing.text(
        ctx, review, Font(NSFont.systemFont(ofSize: 12)), t.ask, x: 12, midY: y,
        width: (reviewButton?.frame.minX ?? bounds.width) - 20)
    }
  }

  static func mix(_ c: CGColor, _ k: CGFloat, over base: CGColor) -> CGColor {
    let a =
      c.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)?.components ?? []
    let b =
      base.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)?.components ?? []
    guard a.count >= 3, b.count >= 3 else { return base }
    return CGColor(
      srgbRed: b[0] + (a[0] - b[0]) * k, green: b[1] + (a[1] - b[1]) * k, blue: b[2] + (a[2] - b[2]) * k, alpha: 1)
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for a in trackingAreas where a.owner === self { removeTrackingArea(a) }
    // a question's tools come with its own text hovered, its bar too (.qbody:hover > .kt)
    let r = qbody.map { $0.union(bar.frame) } ?? bounds
    addTrackingArea(
      NSTrackingArea(
        rect: r,
        options: qbody == nil
          ? [.mouseEnteredAndExited, .activeAlways, .inVisibleRect] : [.mouseEnteredAndExited, .activeAlways],
        owner: self))
  }

  override func mouseEntered(with e: NSEvent) { hovered = true }
  override func mouseExited(with e: NSEvent) { hovered = false }

  override func mouseDown(with e: NSEvent) { popOf(self)?.pressedElsewhere() }

  /// The pulse round it while it flashes (tests)
  private(set) var flashRing: CALayer?

  /// One soft pulse round it, the question list having gone to it (notes.tsx focus, .slip.flash): a 2 ring of the
  /// question's amber in a 6 one of it at 22 %, held for the first 35 % of 1.1 s, then gone
  func flash() {
    wantsLayer = true
    guard let layer else { return }
    let ring = CALayer()
    ring.frame = bounds.insetBy(dx: -6, dy: -6)
    ring.borderWidth = 4
    ring.borderColor = theme.ask.copy(alpha: 0.22)
    let inner = CALayer()
    inner.frame = CGRect(x: 4, y: 4, width: bounds.width + 4, height: bounds.height + 4)
    inner.borderWidth = 2
    inner.borderColor = theme.ask
    ring.addSublayer(inner)
    ring.opacity = 0
    layer.addSublayer(ring)
    flashRing = ring
    let a = CAKeyframeAnimation(keyPath: "opacity")
    a.values = [1, 1, 0]
    a.keyTimes = [0, 0.35, 1]
    a.timingFunctions = [
      CAMediaTimingFunction(name: .linear), CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1),
    ]
    a.duration = 1.1
    CATransaction.begin()
    CATransaction.setCompletionBlock { MainActor.assumeIsolated { ring.removeFromSuperlayer() } }
    ring.add(a, forKey: "flash")
    CATransaction.commit()
  }

  override func rightMouseDown(with e: NSEvent) {
    guard let onMenu, let v = popOf(self)?.view else { return super.rightMouseDown(with: e) }
    onMenu(v.convert(e.locationInWindow, from: nil))
  }
}

@MainActor private func popOf(_ v: NSView) -> SidenotePop? {
  var s: NSView? = v
  while let x = s {
    if let p = x as? PopView { return p.pop }
    s = x.superview
  }
  return nil
}

/// An answer under a question (.hxpop .ans): a thin bar at its left, its text, its tools while hovered
final class AnswerView: NSView, Writable {
  let theme: Theme
  var body: MDBody?
  var tools: [PopButton] = []
  var onEdit: (() -> Void)?
  var writing: MarkdownEditorView? {
    didSet {
      oldValue?.removeFromSuperview()
      if let w = writing { addSubview(w) }
    }
  }
  private let bar = ToolBar()
  private var hovered = false {
    didSet { bar.isHidden = !hovered || writing != nil }
  }

  init(theme: Theme) {
    self.theme = theme
    super.init(frame: .zero)
    bar.theme = theme
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  func assemble() {
    if let body { addSubview(body) }
    bar.buttons = tools
    bar.isHidden = true
    addSubview(bar)
  }

  /// padding 1 0 1 11
  func fit(width w: CGFloat) -> CGFloat {
    var h: CGFloat
    if let writing {
      writing.setFrameOrigin(CGPoint(x: 11, y: 1))
      h = max(writing.frame.height, 20)
    } else if let body {
      body.frame = CGRect(x: 11, y: 1, width: body.layout.width, height: max(body.layout.height, 20))
      h = body.frame.height
    } else {
      h = 20
    }
    bar.place()
    bar.frame.origin = CGPoint(x: w + 6 - bar.frame.width, y: -4)
    return h + 2
  }

  override func draw(_ dirty: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let open = (superview as? SlipView)?.question == false
    ctx.setFillColor(open ? theme.ask.copy(alpha: 0.34)! : theme.ink.copy(alpha: 0.14)!)
    ctx.fill(CGRect(x: 0, y: 0, width: 2, height: bounds.height))
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for a in trackingAreas where a.owner === self { removeTrackingArea(a) }
    addTrackingArea(
      NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }

  override func mouseEntered(with e: NSEvent) { hovered = true }
  override func mouseExited(with e: NSEvent) { hovered = false }
  override func rightMouseDown(with e: NSEvent) { superview?.rightMouseDown(with: e) }
}

/// A slip's tools (.hxpop .kt): 22 square buttons 1 apart on the surface, a hairline ring and a small shadow
final class ToolBar: NSView {
  var theme = Theme.warmInk
  var buttons: [PopButton] = [] {
    didSet {
      for b in oldValue { b.removeFromSuperview() }
      for b in buttons { addSubview(b) }
    }
  }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }

  func place() {
    var x: CGFloat = 1
    for b in buttons {
      b.frame = CGRect(x: x, y: 1, width: 22, height: 22)
      x += 23
    }
    frame.size = CGSize(width: x, height: 24)
    layer?.backgroundColor = theme.surface
    layer?.cornerRadius = 7
    layer?.borderColor = theme.hair
    layer?.borderWidth = 1
    layer?.shadowColor = CGColor(gray: 0, alpha: 1)
    layer?.shadowOpacity = 0.18
    layer?.shadowRadius = 3
    layer?.shadowOffset = CGSize(width: 0, height: -2)
  }
}

/// A sidenote's Markdown at rest, drawn by the native component as its slip shows it; a double-click writes in it, a
/// click on a drawn ref or a link is handed on
final class MDBody: NSView {
  let layout: BlockLayout
  let folder: URL
  let dark: Bool
  var onDouble: (() -> Void)?
  var onRef: (((label: String, target: String?, rect: CGRect, go: Bool)?) -> Void)?
  var onLink: ((String) -> Void)?
  /// a task's box clicked: the nth task in its source
  var onTask: ((Int) -> Void)?

  init(layout: BlockLayout, folder: URL, dark: Bool) {
    self.layout = layout
    self.folder = folder
    self.dark = dark
    super.init(frame: CGRect(origin: .zero, size: layout.size))
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func draw(_ dirty: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let scale = window?.backingScaleFactor ?? 2
    ctx.setShouldSubpixelQuantizeFonts(false)
    ctx.setAllowsFontSubpixelQuantization(false)
    let (folder, dark) = (folder, dark)
    layout.draw(in: ctx, scale: scale, clip: dirty) { slot in
      NativeNotes.image(
        slot, folder: folder, pictures: CanvasView.pictures, scale: scale, dark: dark, images: CanvasView.sharedImages)
    }
  }

  /// a right-click is its slip's (AppKit hands it to no one when a view's own menu is nil)
  override func rightMouseDown(with e: NSEvent) { superview?.rightMouseDown(with: e) }

  override func mouseDown(with e: NSEvent) {
    let p = convert(e.locationInWindow, from: nil)
    // a ref's press is its alone: what is being written stays (refclick.ts takes the press before the editor's blur)
    if let r = layout.drawnRefs.first(where: { $0.rect.contains(p) }) {
      onRef?(e.clickCount == 1 ? (r.label, r.target, r.rect, e.modifierFlags.contains(.command)) : nil)
      return
    }
    popOf(self)?.pressedElsewhere()
    if e.clickCount == 1, let onTask, let k = layout.task(at: p) {
      onTask(k)
      return
    }
    if e.clickCount == 1, let l = layout.link(at: p) {
      onLink?(l.url)
      return
    }
    if e.clickCount == 2 { onDouble?() }
  }
}

/// A code sidenote's lines (notes.tsx SnCode, .pcode: 11 / 19 mono, 5 above and below, its numbers 40 wide): past 8
/// lines cut there, fading out; a click opens it all or cuts it again
final class PopCodeLines: NSView {
  static let shown = 8
  let lines: [String]
  let tokens: [[Token]]
  let start: Int
  let theme: Theme
  private(set) var cut: Bool
  var onToggle: (() -> Void)?
  var long: Bool { lines.count > Self.shown }

  init(lines: [String], tokens: [[Token]], start: Int, theme: Theme) {
    self.lines = lines
    self.tokens = tokens
    self.start = start
    self.theme = theme
    cut = lines.count > Self.shown
    super.init(frame: .zero)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  func fit(width: CGFloat) -> CGFloat {
    cut ? CGFloat(Self.shown) * 19 + 5 : CGFloat(lines.count) * 19 + 10
  }

  override func draw(_ dirty: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let t = theme
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    ctx.saveGState()
    ctx.clip(to: bounds)
    for (i, line) in lines.enumerated() {
      let mid = 5 + CGFloat(i) * 19 + 9.5
      guard mid - 10 < bounds.height else { break }
      let no = String(start + i)
      Drawing.text(ctx, no, t.code, t.number, x: 30 - Drawing.width(no, t.code), midY: mid, width: 30)
      let runs = (i < tokens.count ? tokens[i] : []).map { CodeRun(columns: $0.columns, style: $0.kind.rawValue) }
      CodeDraw.line(line, runs: runs, in: ctx, x: 40, midY: mid, style: t.codeStyle)
    }
    ctx.restoreGState()
    if cut {
      // the last 44 fade into the surface
      let space = CGColorSpace(name: CGColorSpace.sRGB)!
      if let g = CGGradient(
        colorsSpace: space, colors: [t.surface.copy(alpha: 0)!, t.surface] as CFArray, locations: [0, 1])
      {
        ctx.drawLinearGradient(
          g, start: CGPoint(x: 0, y: bounds.height - 44), end: CGPoint(x: 0, y: bounds.height), options: [])
      }
    }
  }

  override func mouseDown(with e: NSEvent) {
    popOf(self)?.endFields()
    toggle()
  }

  override func rightMouseDown(with e: NSEvent) { superview?.rightMouseDown(with: e) }

  func toggle() {
    guard long else { return }
    cut.toggle()
    needsDisplay = true
    onToggle?()
  }
}

/// The input at the bottom (.ncomp): a frame in the accent (in amber as a question, its ? at the left), the Notes'
/// editor in it, the ? and the code switch at its right end; switched, a code search with its results under it. As an
/// answer's input it has neither
final class Composer: NSView, Fits {
  enum Mode { case text, code }
  let theme: Theme
  /// The question it answers
  let replyTo: String?
  var asking: Bool
  var mode = Mode.text
  var editor: MarkdownEditorView?
  var search: NSTextField?
  var found: [SidenotePop.Found] = []
  var chosen = 0
  var results: [PopButton] = [] {
    didSet {
      for b in oldValue { b.removeFromSuperview() }
      for (i, b) in results.enumerated() {
        b.on = i == chosen
        addSubview(b)
      }
    }
  }
  var onAsk: (() -> Void)?
  var onCode: (() -> Void)?
  private(set) var askButton: PopButton?
  private(set) var codeButton: PopButton?
  private var box = CGRect.zero

  init(theme: Theme, replyTo: String?, ask: Bool) {
    self.theme = theme
    self.replyTo = replyTo
    asking = ask
    super.init(frame: .zero)
    // its field's [[ list hangs out of it
    clipsToBounds = false
    if replyTo == nil {
      let a = PopButton.tool("Question", SidenotePop.icon("question"), theme) { [weak self] in self?.onAsk?() }
      let c = PopButton.tool("Code", SidenotePop.icon("code"), theme) { [weak self] in self?.onCode?() }
      // takes no focus: pressing one keeps the caret where it is
      askButton = a
      codeButton = c
      addSubview(a)
      addSubview(c)
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  /// The text's width in a row that wide: the frame's border and padding (1 + 8 left, 2 + 1 right), the ? mark, the
  /// two switches
  func textWidth(_ w: CGFloat) -> CGFloat {
    w - 12 - (asking && mode == .text ? 19 : 0) - (askButton == nil ? 0 : 48)
  }

  func fit(width w: CGFloat) -> CGFloat {
    let left: CGFloat = 9 + (asking && mode == .text ? 19 : 0)
    var inner: CGFloat = 20
    if let e = editor {
      let tw = textWidth(w)
      if abs(e.core.layout.width - tw) > 0.5 { e.core.relayout(e.core.layout.laid(width: tw)) }
      e.setFrameOrigin(CGPoint(x: left, y: 5))
      inner = max(e.frame.height, 20)
    }
    if let s = search {
      // a search icon then the input, 12 / 1.55 mono
      s.frame = CGRect(x: left + 15, y: 4, width: textWidth(w) - 15, height: 19)
      inner = 20
    }
    let h = inner + 8
    box = CGRect(x: 0, y: 0, width: w, height: h)
    let bx = w - 3 - (askButton == nil ? 0 : 46)
    askButton?.frame = CGRect(x: bx, y: 3, width: 22, height: 22)
    codeButton?.frame = CGRect(x: bx + 24, y: 3, width: 22, height: 22)
    askButton?.on = asking && mode == .text
    askButton?.tint = asking && mode == .text ? theme.ask : nil
    codeButton?.on = mode == .code
    // the results under it (.ncomp .sres): 5 down, 3 in, a row each
    var y = h + 5 + 3
    for b in results {
      b.frame = CGRect(x: 3, y: y, width: w - 6, height: 28)
      y += 28
    }
    needsDisplay = true
    return results.isEmpty ? h : y + 3
  }

  override func draw(_ dirty: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let t = theme
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    let ask = asking && mode == .text
    let edge: CGColor = replyTo != nil ? t.ask.copy(alpha: 0.34)! : ask ? t.ask : t.accent
    let ring = (replyTo != nil || ask ? t.ask : t.accent).copy(alpha: replyTo != nil ? 0.1 : ask ? 0.16 : 0.14)!
    let r = box.insetBy(dx: 0.5, dy: 0.5)
    let path = CGPath(roundedRect: r, cornerWidth: 8.5, cornerHeight: 8.5, transform: nil)
    // its ring 3 out, under the frame
    ctx.saveGState()
    ctx.addPath(path)
    ctx.setStrokeColor(ring)
    ctx.setLineWidth(6)
    ctx.strokePath()
    ctx.restoreGState()
    ctx.addPath(path)
    ctx.setFillColor(ask ? SlipView.mix(t.ask, 0.09, over: t.surface) : t.surface)
    ctx.fillPath()
    ctx.addPath(path)
    ctx.setStrokeColor(edge)
    ctx.setLineWidth(1)
    ctx.strokePath()
    if ask {
      let m = CGRect(x: 6, y: 5, width: 16, height: 16)
      ctx.addEllipse(in: m)
      ctx.setFillColor(t.ask)
      ctx.fillPath()
      let f = Font(NSFont.systemFont(ofSize: 11, weight: .bold))
      Drawing.text(ctx, "?", f, t.askInk, x: m.midX - Drawing.width("?", f) / 2, midY: m.midY, width: 16)
    }
    if mode == .code {
      Icons.stroke(SidenotePop.icon("search"), scale: 13 / 16, at: CGPoint(x: 8, y: 8), color: t.ink3, in: ctx)
    }
    if !results.isEmpty {
      let top = box.maxY + 5
      let panel = CGRect(x: 0, y: top, width: bounds.width, height: bounds.height - top)
      ctx.addPath(
        CGPath(roundedRect: panel.insetBy(dx: 0.5, dy: 0.5), cornerWidth: 8.5, cornerHeight: 8.5, transform: nil))
      ctx.setFillColor(t.surface)
      ctx.fillPath()
      ctx.addPath(
        CGPath(roundedRect: panel.insetBy(dx: 0.5, dy: 0.5), cornerWidth: 8.5, cornerHeight: 8.5, transform: nil))
      ctx.setStrokeColor(t.hair)
      ctx.strokePath()
    }
  }
}

/// One of the popup's buttons (main's <button>s): it acts on a release over it; the pointer over it lights it
final class PopButton: NSView {
  enum Look {
    /// an icon in a square (.ib: in the title bar 26, a slip's tools 22), its size
    case icon(CGPath, CGFloat, head: Bool)
    /// the + row at the bottom (.hxpop .add)
    case add
    /// a question's reply row (.hxpop .reply)
    case reply
    /// a text button (.tbtn)
    case text
    /// a link in a code sidenote's head (a.lnk)
    case link
    /// a result of the code search (.cand)
    case found(SidenotePop.Found)
  }
  let label: String
  let look: Look
  let theme: Theme
  var action: () -> Void
  var on = false {
    didSet { if on != oldValue { needsDisplay = true } }
  }
  /// The colour it is drawn in while on, when not the accent
  var tint: CGColor?
  private var hot = false {
    didSet { if hot != oldValue { needsDisplay = true } }
  }
  private var down = false

  init(_ label: String, _ look: Look, _ theme: Theme, _ action: @escaping () -> Void) {
    self.label = label
    self.look = look
    self.theme = theme
    self.action = action
    super.init(frame: .zero)
    setAccessibilityElement(true)
    setAccessibilityRole(.button)
    setAccessibilityLabel(label)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  static func head(_ l: String, _ icon: CGPath, _ size: CGFloat, _ t: Theme, _ a: @escaping () -> Void) -> PopButton {
    PopButton(l, .icon(icon, size, head: true), t, a)
  }
  static func tool(_ l: String, _ icon: CGPath, _ t: Theme, _ a: @escaping () -> Void) -> PopButton {
    PopButton(l, .icon(icon, 14, head: false), t, a)
  }
  static func add(_ t: Theme, _ a: @escaping () -> Void) -> PopButton { PopButton("Add Sidenote", .add, t, a) }
  static func reply(_ t: Theme, _ a: @escaping () -> Void) -> PopButton { PopButton("Answer", .reply, t, a) }
  static func text(_ l: String, _ t: Theme, _ a: @escaping () -> Void) -> PopButton { PopButton(l, .text, t, a) }
  static func link(_ url: String, _ t: Theme, _ a: @escaping () -> Void) -> PopButton { PopButton(url, .link, t, a) }
  static func found(_ f: SidenotePop.Found, _ t: Theme, _ a: @escaping () -> Void) -> PopButton {
    PopButton(f.label, .found(f), t, a)
  }

  /// The first button labelled so in `root`
  static func find(_ label: String, in root: NSView) -> PopButton? {
    if let b = root as? PopButton, b.label == label { return b }
    for v in root.subviews { if let b = find(label, in: v) { return b } }
    return nil
  }

  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for a in trackingAreas where a.owner === self { removeTrackingArea(a) }
    addTrackingArea(
      NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }

  override func mouseEntered(with e: NSEvent) { hot = true }
  override func mouseExited(with e: NSEvent) { hot = false }
  override func mouseDown(with e: NSEvent) { down = true }
  override func mouseUp(with e: NSEvent) {
    guard down else { return }
    down = false
    if bounds.contains(convert(e.locationInWindow, from: nil)) { action() }
  }

  override func draw(_ dirty: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let t = theme
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    let b = bounds
    switch look {
    case .icon(let path, let size, let head):
      if hot {
        ctx.addPath(
          CGPath(roundedRect: b, cornerWidth: head ? 8.5 : 6, cornerHeight: head ? 8.5 : 6, transform: nil))
        ctx.setFillColor(head ? t.ink.copy(alpha: 0.07)! : t.hlrow)
        ctx.fillPath()
      }
      if on, let tint {
        ctx.addPath(CGPath(roundedRect: b, cornerWidth: 6, cornerHeight: 6, transform: nil))
        ctx.setFillColor(tint.copy(alpha: 0.14)!)
        ctx.fillPath()
      }
      let ink = on ? (tint ?? t.accent) : hot ? t.ink : head ? t.ink2 : t.ink3
      Icons.stroke(
        path, scale: size / 16, at: CGPoint(x: (b.width - size) / 2, y: (b.height - size) / 2), color: ink, in: ctx)
    case .add, .reply:
      let add = if case .add = look { true } else { false }
      let r = b.insetBy(dx: 0.5, dy: 0.5)
      let p = CGPath(roundedRect: r, cornerWidth: add ? 9 : 7, cornerHeight: add ? 9 : 7, transform: nil)
      if !add && hot {
        ctx.addPath(p)
        ctx.setFillColor(t.ask.copy(alpha: 0.07)!)
        ctx.fillPath()
      }
      ctx.addPath(p)
      ctx.setLineDash(phase: 0, lengths: [3, 2])
      ctx.setStrokeColor(add ? (hot ? t.accent : t.hair) : (hot ? t.ask : t.ask.copy(alpha: 0.34)!))
      ctx.strokePath()
      ctx.setLineDash(phase: 0, lengths: [])
      let ink = add ? (hot ? t.accent : t.ink3) : (hot ? t.ask : SlipView.mix(t.ask, 0.75, over: t.ink3))
      if add {
        Icons.stroke(
          SidenotePop.icon("plus"), scale: 14 / 16, at: CGPoint(x: (b.width - 14) / 2, y: (b.height - 14) / 2),
          color: ink, in: ctx)
      } else {
        Icons.stroke(
          SidenotePop.icon("reply"), scale: 13 / 16, at: CGPoint(x: 9, y: (b.height - 13) / 2), color: ink, in: ctx)
      }
    case .text:
      if hot {
        ctx.addPath(CGPath(roundedRect: b, cornerWidth: 8.5, cornerHeight: 8.5, transform: nil))
        ctx.setFillColor(t.ink.copy(alpha: 0.07)!)
        ctx.fillPath()
      }
      Drawing.text(
        ctx, label, Font(NSFont.systemFont(ofSize: 12.5)), hot ? t.ink : t.ink2, x: 10, midY: b.midY,
        width: b.width - 20)
    case .link:
      let f = Font.mono(11, .regular)
      let c = MarkdownLooks.theme(t.id.rawValue, dark: t.dark).colors.link.cg
      Drawing.text(ctx, label, f, c, x: 0, midY: b.midY, width: b.width)
      if hot {
        ctx.setFillColor(c)
        ctx.fill(CGRect(x: 0, y: b.midY + 6, width: min(b.width, Drawing.width(label, f)), height: 1))
      }
    case .found(let f):
      if on || hot {
        ctx.addPath(CGPath(roundedRect: b, cornerWidth: 6, cornerHeight: 6, transform: nil))
        ctx.setFillColor(t.hlrow)
        ctx.fillPath()
      }
      let small = Font(NSFont.systemFont(ofSize: 11))
      Drawing.text(ctx, f.symbol ? "ƒ" : "▤", Font.mono(11, .regular), t.ink3, x: 8, midY: b.midY, width: 14)
      let lw = min(Drawing.width(f.label, Font.mono(12, .regular)), b.width * 0.6)
      Drawing.text(ctx, f.label, Font.mono(12, .regular), t.ink, x: 26, midY: b.midY, width: lw)
      Drawing.text(ctx, f.detail, small, t.ink3, x: 26 + lw + 8, midY: b.midY, width: b.width - 26 - lw - 16)
    }
  }
}
