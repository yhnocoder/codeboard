import AppKit
import CodeBoardModel
import CodeBoardNotes
import os

// The questions (web board ui/QuestionList.tsx, actions/questions.ts, core questions.ts): the toolbar's ? with how many
// of this board's are open, and their list over it, this board's from the scene, the other boards' read from the vault
// when it opens. A row takes the camera to its question and opens its popup there; one on another board opens that
// board first (onOpenBoard), which then goes to it (showQuestion). The questions on the entries' passages (papers'
// and PDFs' annotations, from the source provider) are rows too, each entry a group of its own after the boards; a row
// shows its passage in the reading pane. Back on a board after a while with questions still open on it, a hint says
// how many (host boards.ts welcomeOf, ui/QuestionList.tsx WelcomeHint).

extension CanvasView {
  /// One list for the app
  static var sharedList: QuestionListView?
  /// Watches for a press outside the list while it is open
  static var listOutside: Any?
  /// The canvas the list is open on: opening it on another closes it there first, as there is one list
  static weak var listOwner: CanvasView?

  /// The group an entry's questions are listed under: not a board id
  static let entryGroup = "entry:"

  package var questionList: QuestionListView {
    if let l = CanvasView.sharedList { return l }
    let l = QuestionListView()
    CanvasView.sharedList = l
    return l
  }

  /// How many of this board's questions are open
  var openQuestions: Int { scene?.notes.filter(\.isOpenQuestion).count ?? 0 }

  /// Tells the toolbar how many are open (the board changed)
  func questionsChanged() {
    let n = openQuestions
    if n != shownQuestions {
      shownQuestions = n
      dock.questions = n
      onQuestions?(n)
    }
    if listShown, let doc = document, let (vb, vault) = shown {
      questionList.update(listData(doc.board, vb, vault, others: listOthers))
    }
  }

  /// This board's questions as list rows, and where each is (core questionWhere)
  nonisolated static func items(
    _ b: Board, notes: [Sidenote], board: VaultBoard, title: (Card) -> String
  ) -> [QuestionListView.Shown.Item] {
    notes.compactMap { n in
      guard case .text(let t) = n.body, let q = t.question else { return nil }
      var place = ""
      switch n.anchor {
      case .section(let s): place = b.section(s)?.title ?? ""
      case .card(let c, let seg, let lines, _):
        guard let card = b.card(c) else { break }
        let name = title(card)
        if let lines, let seg {
          let ln =
            lines.lowerBound == lines.upperBound ? "\(lines.lowerBound)" : "\(lines.lowerBound)–\(lines.upperBound)"
          let path = b.segment(c, seg).flatMap(CodeLayout.path)
          if let file = path?.split(separator: "/").last {
            place = "\(file):\(ln)"
          } else {
            place = "\(name.isEmpty ? "" : "\(name) · ")line\(lines.count == 1 ? "" : "s") \(ln)"
          }
        } else {
          place = name
        }
      case .point: break
      }
      let line = RefResolver.firstLine(t.text)
      return .init(
        board: board.id.rawValue, note: n.id.rawValue, line: line.isEmpty ? "(no text)" : line, where: place,
        done: q.done, at: q.at)
    }
  }

  /// The other boards' questions (host exports.ts allQuestions, core collectQuestions): each board with its shared cards
  /// read in; one that travels with a shared card is listed once, on the first board in the vault that shows it (this
  /// one, `current`, among them)
  nonisolated static func otherQuestions(
    in vault: Vault, current: Board, at vb: VaultBoard
  ) -> [(VaultBoard, [QuestionListView.Shown.Item])] {
    var seen = Set<String>()
    return ((try? vault.tree().allBoards) ?? []).compactMap { o in
      let read = o.id == vb.id ? current : (try? vault.board(at: o.path))?.inflated { try? vault.sharedCard($0) }
      guard let ob = read else { return nil }
      let r = RefResolver(ob, package: vault.url(of: o.path), vault: vault)
      let rows = items(ob, notes: ob.sidenotes, board: o, title: r.title).filter { seen.insert($0.note).inserted }
      return o.id == vb.id ? nil : (o, rows)
    }
  }

  func listData(
    _ b: Board, _ vb: VaultBoard, _ vault: Vault, others: [(VaultBoard, [QuestionListView.Shown.Item])]
  ) -> QuestionListView.Shown {
    let resolver = RefResolver(b, package: vault.url(of: vb.path), vault: vault)
    let mine = Self.items(b, notes: scene?.notes ?? b.sidenotes, board: vb, title: resolver.title)
    let entries = entryItems()
    return QuestionListView.Shown(
      look: theme.id.rawValue, dark: theme.dark, board: .init(id: vb.id.rawValue, name: vb.title),
      boards: [.init(id: vb.id.rawValue, name: vb.title)]
        + others.map { .init(id: $0.0.id.rawValue, name: $0.0.title) } + entries.groups,
      questions: mine + others.flatMap(\.1) + entries.rows)
  }

  /// The entries' questions as rows, each entry a group titled with it; where: its place as its source line shows it
  func entryItems() -> (groups: [QuestionListView.Shown.Board], rows: [QuestionListView.Shown.Item]) {
    guard let p = sources else { return ([], []) }
    var groups: [QuestionListView.Shown.Board] = []
    let rows = p.questions().compactMap { q -> QuestionListView.Shown.Item? in
      guard let asked = q.note.question else { return nil }
      let group = Self.entryGroup + q.anchor.entry.rawValue
      if !groups.contains(where: { $0.id == group }) { groups.append(.init(id: group, name: q.entryTitle)) }
      let line = RefResolver.firstLine(q.note.text)
      return .init(
        board: group, note: q.sidenote.rawValue, line: line.isEmpty ? "(no text)" : line,
        where: p.sourceLabel(q.anchor)?.number ?? "", done: asked.done, at: asked.at)
    }
    return (groups, rows)
  }

  /// The dock's ? pressed: the list opens over it (its bottom right 12 above the button's top, 6 right of it), or
  /// closes. `button`: the button's rect in this view
  public func toggleQuestionList(under button: CGRect) {
    if listShown { return closeQuestionList() }
    guard let doc = document, let (vb, vault) = shown, let host = superview else { return }
    // else that canvas would go on believing it shows the list: its next press would close this one's, and what it
    // was still reading would be shown in it
    CanvasView.listOwner?.closeQuestionList()
    CanvasView.listOwner = self
    let list = questionList
    if list.view.superview !== host { host.addSubview(list.view, positioned: .above, relativeTo: self) }
    listShown = true
    listButton = button
    dock.listOpen = true
    list.onPick = { [weak self] board, note in self?.pickQuestion(board, note) }
    list.onClose = { [weak self] in self?.closeQuestionList() }
    list.onSize = { [weak self] _ in self?.placeList() }
    // a press anywhere else in the window closes it (QuestionList.tsx: its Overlay is `outside`); its button toggles it
    CanvasView.listOutside = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) {
      [weak self] e in
      guard let self, e.window === self.window, let host = list.view.superview else { return e }
      if !self.listButton.contains(self.convert(e.locationInWindow, from: nil)),
        list.view.hitTest(host.convert(e.locationInWindow, from: nil)) == nil
      {
        self.closeQuestionList()
      }
      return e
    }
    let b = doc.board
    Task {
      // the other boards' questions: their files read off the main thread
      let others = await Task.detached { CanvasView.otherQuestions(in: vault, current: b, at: vb) }.value
      guard listShown else { return }
      listOthers = others
      await list.show(listData(b, vb, vault, others: others), maxHeight: min(420, bounds.height - 80))
      guard listShown else { return }
      withoutAnimation {
        placeList()
        list.view.alphaValue = 1
      }
      window?.makeFirstResponder(list.view)
    }
  }

  func placeList() {
    let list = questionList
    guard listShown, let host = list.view.superview else { return }
    let corner = convert(CGPoint(x: listButton.maxX + 6, y: listButton.minY - 12), to: host)
    let f = list.frame(bottomRightAt: corner, flipped: host.isFlipped)
    if list.view.frame != f { list.view.frame = f }
  }

  public func closeQuestionList() {
    guard listShown else { return }
    listShown = false
    CanvasView.listOwner = nil
    if let m = CanvasView.listOutside { NSEvent.removeMonitor(m) }
    CanvasView.listOutside = nil
    listOthers = []
    questionList.close()
    dock.listOpen = false
    window?.makeFirstResponder(self)
  }

  /// A row picked: the list closes; on this board the camera goes to it, else its board opens; an entry's shows its
  /// passage in the reading pane
  func pickQuestion(_ board: String, _ note: String) {
    closeQuestionList()
    let id = SidenoteID(rawValue: note)
    if board.hasPrefix(Self.entryGroup) {
      let entry = EntryID(rawValue: String(board.dropFirst(Self.entryGroup.count)))
      if let q = sources?.questions(in: entry).first(where: { $0.sidenote == id }) { sources?.reveal(q.anchor) }
    } else if board == document?.board.id.rawValue {
      showQuestion(id)
    } else {
      onOpenBoard?(BoardID(rawValue: board), .question(id))
    }
  }

  /// The camera to a question when it is not in view (what it is on, with room on its right for the popup), and its
  /// popup open there once the camera is at rest (actions/notes.ts goToQuestion)
  public func showQuestion(_ id: SidenoteID) {
    guard let scene, let n = scene.notes.first(where: { $0.id == id }) else { return }
    func rect(_ o: Scene.Owner) -> CGRect? { scene.items.first { $0.owner == o }?.rect }
    var r: CGRect?
    switch n.anchor {
    case .card(let c, _, _, _): r = rect(.card(c))
    case .section(let s):
      r = scene.frames.first { $0.id == s }.map {
        CGRect(x: $0.rect.minX, y: $0.rect.minY, width: $0.rect.width, height: min($0.rect.height, 120))
      }
    case .point(let x, let y): r = CGRect(x: x - 20, y: y - 20, width: 40, height: 40)
    }
    // the sidenote popups open go first
    openPop(nil)
    if let r {
      let z = camera.zoom
      let room = bounds.width < 700 ? 0 : 500 / z
      reveal(r, also: CGRect(x: r.maxX, y: r.minY, width: room, height: min(r.height, 320 / z)))
    }
    let at: PopAt
    if let l = n.anchor.lines {
      at = .lines(Lines(card: l.card, segment: l.segment, range: shownHighlight(l, in: scene) ?? l.range))
    } else if let s = n.anchor.spot {
      at = .spot(s)
    } else {
      return
    }
    Task {
      await rest()
      openPop(at, focus: id)
    }
  }

  /// Zoom to 100 % (the toolbar's zoom figure), about the middle of the view
  public func zoomTo100() {
    place(zoom: 1, centre: camera.board(CGPoint(x: bounds.midX, y: bounds.midY)))
  }
}

/// When the welcome back hint shows (the setting questions.welcomeBack)
public enum WelcomeBack: String, CaseIterable, Sendable {
  /// When the board was last opened 2 days ago or more
  case twoDays = "2d"
  /// Every time a board with open questions opens
  case always
  case off

  public static let `default` = WelcomeBack.twoDays

  /// As the Settings row's chips say (ui/Settings.tsx)
  public var label: String {
    switch self {
    case .twoDays: "After 2 Days"
    case .always: "Always"
    case .off: "Off"
    }
  }
}

/// The hint (.welcome.pill): its line, Show (a .tbtn) and × (an .ib), at the top middle of the board, 12 down
@MainActor final class WelcomeHint: NSView {
  enum Part: Equatable {
    case show
    case dismiss
  }

  var theme = Theme.warmInk {
    didSet { if !theme.same(as: oldValue) { redraw() } }
  }
  var text = "" {
    didSet { if text != oldValue { redraw() } }
  }
  var onPart: ((Part) -> Void)?
  private var hover: Part? {
    didSet { if hover != oldValue { redraw() } }
  }
  private var pressed: Part?
  private let face = LayerView()
  /// Room around the pill for its shadow
  private static let margin: CGFloat = 32

  init() {
    super.init(frame: .zero)
    wantsLayer = true
    face.wantsLayer = true
    addSubview(face)
    isHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("WelcomeHint is not loaded from nibs") }

  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  /// .welcome: padding 3 3 3 12, gap 8, 12.5; .tbtn 28 tall with 10 on each side; .ib 26 square
  static func layout(_ text: String, theme t: Theme) -> (show: CGRect, dismiss: CGRect, size: CGSize) {
    let f = CrumbsBar.font(t, bold: false)
    let show = CGRect(x: 12 + Drawing.width(text, f) + 8, y: 3, width: 10 + Drawing.width("Show", f) + 10, height: 28)
    let dismiss = CGRect(x: show.maxX + 8, y: 4, width: 26, height: 26)
    return (show, dismiss, CGSize(width: (dismiss.maxX + 3).rounded(.up), height: 34))
  }

  var laidOut: (show: CGRect, dismiss: CGRect, size: CGSize) { Self.layout(text, theme: theme) }

  func part(at p: CGPoint) -> Part? {
    let l = laidOut
    return l.show.contains(p) ? .show : l.dismiss.contains(p) ? .dismiss : nil
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    guard !isHidden, let sv = superview else { return nil }
    return bounds.contains(convert(point, from: sv)) ? self : nil
  }

  func redraw() {
    let t = theme
    let l = laidOut
    let look = BarLook.of(t)
    let m = Self.margin
    let scale = window?.backingScaleFactor ?? 2
    let f = CrumbsBar.font(t, bold: false)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if frame.size != l.size { setFrameSize(l.size) }
    face.frame = bounds.insetBy(dx: -m, dy: -m)
    face.layer?.contentsScale = scale
    face.layer?.contents = CanvasToolbar.bitmap(face.frame.size, scale: scale) { ctx in
      ctx.translateBy(x: m, y: m)
      WritingBar.float(
        CGRect(origin: .zero, size: l.size), radius: look.radius, look: look, glass: HeadActs.glass(t), scale: scale,
        squircle: t.id != .inkWash, in: ctx)
      ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
      Drawing.text(ctx, self.text, f, look.ink, x: 12, midY: l.size.height / 2, width: .infinity)
      // .tbtn:hover, .ib:hover: the ink at 7 % under it, the ink
      for (p, r) in [(Part.show, l.show), (.dismiss, l.dismiss)] where self.hover == p {
        ctx.addPath(CGPath(roundedRect: r, cornerWidth: 8.5, cornerHeight: 8.5, transform: nil))
        ctx.setFillColor(look.ink.copy(alpha: 0.07) ?? look.ink)
        ctx.fillPath()
      }
      Drawing.text(
        ctx, "Show", f, self.hover == .show ? look.ink : look.ink2, x: l.show.minX + 10, midY: l.show.midY,
        width: .infinity)
      Icons.stroke(
        SVGPath.parse("M12 4 4 12M4 4l8 8"), scale: 13 / 16,
        at: CGPoint(x: l.dismiss.midX - 6.5, y: l.dismiss.midY - 6.5),
        color: self.hover == .dismiss ? look.ink : look.ink2, in: ctx)
    }
    CATransaction.commit()
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas where t.owner === self { removeTrackingArea(t) }
    addTrackingArea(
      NSTrackingArea(
        rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
  }

  override func mouseMoved(with e: NSEvent) { hover = part(at: convert(e.locationInWindow, from: nil)) }
  override func mouseExited(with e: NSEvent) { hover = nil }
  override func mouseDown(with e: NSEvent) { pressed = part(at: convert(e.locationInWindow, from: nil)) }
  override func mouseUp(with e: NSEvent) {
    defer { pressed = nil }
    guard let p = pressed, p == part(at: convert(e.locationInWindow, from: nil)) else { return }
    onPart?(p)
  }

  override func isAccessibilityElement() -> Bool { true }
  override func accessibilityRole() -> NSAccessibility.Role? { .group }
  override func accessibilityIdentifier() -> String { "ui-welcome" }
  override func accessibilityLabel() -> String? { text }
  override func accessibilityChildren() -> [Any]? {
    let l = laidOut
    return [
      uiElement("welcomeshow", l.show, label: "Show", in: self),
      uiElement("welcomeclose", l.dismiss, label: "Dismiss", in: self),
    ]
  }
}

private let day: TimeInterval = 86_400

extension CanvasView {
  /// When the hint shows: the app's setting, one for every canvas (read as a board opens)
  public static var welcomeBack = WelcomeBack.default

  /// What the hint says (boards.ts welcomeOf, QuestionList.tsx WelcomeHint): nil when the setting is off, the board was
  /// never opened before, it was opened less than 2 days ago (unless the setting says always) or none of its questions
  /// is open
  nonisolated static func welcome(last: Date?, now: Date, mode: WelcomeBack, open: Int) -> String? {
    guard mode != .off, let last, open > 0 else { return nil }
    let gap = now.timeIntervalSince(last)
    guard mode == .always || gap >= 2 * day else { return nil }
    let days = Int((gap / day).rounded(.down))
    let ago = days <= 0 ? "today" : days == 1 ? "yesterday" : "\(days) days ago"
    return "Welcome back · last opened \(ago) · \(open) open question\(open > 1 ? "s" : "") on this board"
  }

  /// Another board shown in this canvas (not the same one drawn again): when it was last opened before is read, `now`
  /// kept as this opening (per machine, beside the cameras), and the hint shown when it says something; not over a
  /// sub-board entered or left (going in and out is not coming back)
  package func boardOpened(now: Date) {
    guard let (vb, vault) = shown, let store = cameras else { return }
    let last = store.opened(for: vault)[vb.id]
    do {
      try store.keepOpened(vb.id, at: now, for: vault)
    } catch {
      Logger(subsystem: Bundle.main.bundleIdentifier ?? "CodeBoard", category: "questions").error(
        "could not keep when a board was opened: \(error.localizedDescription, privacy: .public)")
    }
    guard crumbs.isEmpty, let text = Self.welcome(last: last, now: now, mode: Self.welcomeBack, open: openQuestions)
    else { return }
    let hint = welcomeHint
    if hint.superview !== self {
      addSubview(hint)
      hint.onPart = { [weak self] in
        guard let self else { return }
        switch $0 {
        case .show: self.showWelcomeQuestions()
        case .dismiss: self.closeWelcome()
        }
      }
    }
    hint.theme = theme
    hint.text = text
    hint.redraw()
    hint.isHidden = false
    placeWelcome()
    // .welcome: popin, 200 ms
    let pop = CABasicAnimation(keyPath: "opacity")
    pop.fromValue = 0
    pop.duration = 0.2
    pop.timingFunction = CAMediaTimingFunction(controlPoints: 0.215, 0.61, 0.355, 1)
    hint.layer?.add(pop, forKey: "popin")
  }

  /// The hint's line while it shows (tests)
  package var welcomeShown: String? { welcomeHint.isHidden ? nil : welcomeHint.text }

  func placeWelcome() {
    guard !welcomeHint.isHidden else { return }
    welcomeHint.setFrameOrigin(CGPoint(x: ((bounds.width - welcomeHint.frame.width) / 2).rounded(), y: 12))
  }

  package func closeWelcome() {
    welcomeHint.isHidden = true
  }

  /// Show: the hint goes and the list opens (actions/questions.ts showWelcomeQuestions)
  package func showWelcomeQuestions() {
    closeWelcome()
    if !listShown { useDock(.questions) }
  }
}
