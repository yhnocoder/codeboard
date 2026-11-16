import AppKit
import CodeBoardModel
import CodeBoardNotes

// The questions (web board ui/QuestionList.tsx, actions/questions.ts, core questions.ts): the toolbar's ? with how many
// of this board's are open, and their list over it, this board's from the scene, the other boards' read from the vault
// when it opens. A row takes the camera to its question and opens its popup there; one on another board opens that
// board first (onOpenBoard), which then goes to it (showQuestion). The questions on the entries' passages (papers'
// and PDFs' annotations, from the source provider) are rows too, each entry a group of its own after the boards; a row
// shows its passage in the reading pane.

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
