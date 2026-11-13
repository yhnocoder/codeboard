import AppKit
import CodeBoardModel
import CodeBoardNotes

// The questions (web board ui/QuestionList.tsx, actions/questions.ts, core questions.ts): the toolbar's ? with how many
// of this board's are open, and their list over it, this board's from the scene, the other boards' read from the vault
// when it opens. A row takes the camera to its question and opens its popup there; one on another board opens that
// board first (onOpenBoard), which then goes to it (showQuestion).

extension CanvasView {
  /// One list for the app
  static var sharedList: QuestionListView?

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
      var where_ = ""
      switch n.anchor {
      case .section(let s): where_ = b.section(s)?.title ?? ""
      case .card(let c, let seg, let lines, _):
        guard let card = b.card(c) else { break }
        let name = title(card)
        if let lines, let seg {
          let ln =
            lines.lowerBound == lines.upperBound ? "\(lines.lowerBound)" : "\(lines.lowerBound)–\(lines.upperBound)"
          let path = b.segment(c, seg).flatMap(CodeLayout.path)
          if let file = path?.split(separator: "/").last {
            where_ = "\(file):\(ln)"
          } else {
            where_ = "\(name.isEmpty ? "" : "\(name) · ")line\(lines.count == 1 ? "" : "s") \(ln)"
          }
        } else {
          where_ = name
        }
      case .point: break
      }
      let line = RefResolver.firstLine(t.text)
      return .init(
        board: board.id.rawValue, note: n.id.rawValue, line: line.isEmpty ? "(no text)" : line, where: where_,
        done: q.done, at: q.at)
    }
  }

  func listData(
    _ b: Board, _ vb: VaultBoard, _ vault: Vault, others: [(VaultBoard, [QuestionListView.Shown.Item])]
  ) -> QuestionListView.Shown {
    let resolver = RefResolver(b, package: vault.url(of: vb.path), vault: vault)
    let mine = Self.items(b, notes: scene?.notes ?? b.sidenotes, board: vb, title: resolver.title)
    return QuestionListView.Shown(
      look: theme.id.rawValue, dark: theme.dark, board: .init(id: vb.id.rawValue, name: vb.title),
      boards: [.init(id: vb.id.rawValue, name: vb.title)]
        + others.map { .init(id: $0.0.id.rawValue, name: $0.0.title) },
      questions: mine + others.flatMap(\.1))
  }

  /// The toolbar's ? pressed: the list opens over it (its bottom right 12 above the button's top, 6 right of it), or
  /// closes. `button`: the button's rect in this view
  public func toggleQuestionList(under button: CGRect) {
    if listShown { return closeQuestionList() }
    guard let doc = document, let (vb, vault) = shown, let host = superview else { return }
    let list = questionList
    if list.view.superview !== host { host.addSubview(list.view, positioned: .above, relativeTo: self) }
    listShown = true
    listButton = button
    onListOpen?(true)
    list.onPick = { [weak self] board, note in self?.pickQuestion(board, note) }
    list.onClose = { [weak self] in self?.closeQuestionList() }
    list.onSize = { [weak self] _ in self?.placeList() }
    let b = doc.board
    Task {
      // the other boards' questions: their files read off the main thread
      let others = await Task.detached { () -> [(VaultBoard, [QuestionListView.Shown.Item])] in
        let all = (try? vault.tree().allBoards) ?? []
        return all.filter { $0.id != vb.id }.compactMap { o in
          guard let ob = try? vault.board(at: o.path) else { return nil }
          let r = RefResolver(ob, package: vault.url(of: o.path), vault: vault)
          return (o, CanvasView.items(ob, notes: ob.sidenotes, board: o, title: r.title))
        }
      }.value
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
    listOthers = []
    questionList.close()
    onListOpen?(false)
    window?.makeFirstResponder(self)
  }

  /// A row picked: the list closes; on this board the camera goes to it, else its board opens
  func pickQuestion(_ board: String, _ note: String) {
    closeQuestionList()
    let id = SidenoteID(rawValue: note)
    if board == document?.board.id.rawValue { showQuestion(id) } else { onOpenBoard?(BoardID(rawValue: board), id) }
  }

  /// The camera to a question (what it is on in view, with room on its right for the popup), and its popup open there
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
    if let r {
      let z = camera.zoom
      let room = bounds.width < 700 ? 0 : 500 / z
      let want = r.union(CGRect(x: r.maxX, y: r.minY, width: room, height: min(r.height, 320 / z)))
      if !camera.visible(bounds.size).contains(want) { place(zoom: z, centre: CGPoint(x: want.midX, y: want.midY)) }
    }
    let at: PopAt
    if let l = n.anchor.lines {
      at = .lines(Lines(card: l.card, segment: l.segment, range: shownHighlight(l, in: scene) ?? l.range))
    } else if let s = n.anchor.spot {
      at = .spot(s)
    } else {
      return
    }
    openPop(at, focus: id)
  }

  /// Zoom to 100 % (the toolbar's zoom figure), about the middle of the view
  public func zoomTo100() {
    place(zoom: 1, centre: camera.board(CGPoint(x: bounds.midX, y: bounds.midY)))
  }
}
