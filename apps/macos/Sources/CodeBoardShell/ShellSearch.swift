import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes

// ⌘K and ⌘F (keymap.ts search, searchBoard; ui/Palette.tsx): the search palette over the board in front, on all boards
// or this board's. The boards open in a tab are searched as they are now, the rest as their files are. A card picked
// on this board is brought into view and selected; one on another board opens that board in the tab, at the card; one
// on a Shelf is shown large beside the opened Shelf and left there, the board not edited. Esc or a click outside closes it, the camera where it was. Related by Meaning (host
// meaning.ts) asks box, the index service VS Code's windows share: the boards handed to it when the palette opens, then
// each query searched and, its answer whole, read again by the reranker. With no embedding address it is off and box is
// never asked.

extension BoardPanes {
  /// One palette for the app
  @MainActor static let search = SearchPanel()
  /// Related by Meaning's index, its settings and its key (tests put their own here)
  @MainActor static var meaningIndex: any MeaningIndex = BoxService(bin: bundledBox)
  @MainActor static var searchSettings = SearchSettings(defaults: .standard)
  @MainActor static var embeddingKeys: any KeyStore = KeychainKeyStore(account: SearchSettings.keyAccount)
  /// Whether the reranker is worth asking, for the settings it was made under (new settings: asked again)
  @MainActor private static var rerankGate = (settings: [String](), gate: RerankGate())

  /// The box binary the app carries beside its own executable (Contents/MacOS/box); nil: only a service already
  /// running (one VS Code started) is used
  static var bundledBox: URL? {
    guard let bin = Bundle.main.executableURL?.deletingLastPathComponent().appending(path: "box"),
      FileManager.default.isExecutableFile(atPath: bin.path)
    else { return nil }
    return bin
  }

  /// The View menu's Search… (⌘K) and the toolbar's Search
  @objc func searchBoards(_ sender: Any?) { openSearch(thisBoard: false) }
  /// The View menu's Search This Board… (⌘F)
  @objc func searchThisBoard(_ sender: Any?) { openSearch(thisBoard: true) }

  /// The pane in front, with its board
  private var frontPane: Pane? {
    shell.selected.flatMap { panes[$0] }.flatMap { $0.document == nil ? nil : $0 }
  }

  func openSearch(thisBoard: Bool) {
    let s = Self.search
    guard !s.isOpen, let pane = frontPane, let here = pane.document?.id, let vault = shell.vault else { return }
    let tree = shell.tree?.allBoards ?? []
    // the open boards as they are now; the others' files read off the main thread
    let live = tree.compactMap { b in documents[b.id].map { (b, $0.board) } }
    let unread = tree.filter { documents[$0.id] == nil }
    let sources = Task.detached { () -> [BoardSearch.Source] in
      var read: [BoardID: Board] = [:]
      for b in unread {
        read[b.id] = (try? vault.board(at: b.path))?.inflated { try? vault.sharedCard($0) }
      }
      let now = Dictionary(live.map { ($0.0.id, $0.1) }, uniquingKeysWith: { a, _ in a })
      return tree.compactMap { b in
        (now[b.id] ?? read[b.id]).map {
          BoardSearch.Source(
            id: b.id, name: b.title, board: $0, images: vault.url(of: b.path).appending(path: Vault.imagesFolder))
        }
      }
    }
    s.onSearch = { q, thisBoard in
      BoardSearch.search(q, in: await sources.value, here: here, thisBoard: thisBoard)
    }
    wireMeaning(s, sources: sources, vault: vault, here: here)
    s.onPick = { [weak self] in self?.picked($0) }
    s.onClose = { [weak self] in self?.closeSearch() }
    s.view.frame = pane.bounds
    s.view.autoresizingMask = [.width, .height]
    if s.view.superview !== pane { pane.addSubview(s.view) }
    let look = shell.look
    Task { await s.show(.init(look: look.id.rawValue, dark: look.dark, here: thisBoard)) }
  }

  /// Related by Meaning: the boards handed to box now, in the background; a query searched with what the words found
  /// left out, then reranked once its answer is whole
  private func wireMeaning(
    _ s: SearchPanel, sources: Task<[BoardSearch.Source], Never>, vault: Vault, here: BoardID
  ) {
    let settings = Self.searchSettings
    guard let embedder = settings.embedder(keys: Self.embeddingKeys) else {
      s.onMeaning = { _, _, reply in await reply(.init(items: [], off: true)) }
      return
    }
    let index = Self.meaningIndex
    let rerank = settings.rerank
    let rerankModel = settings.rerankModel.trimmingCharacters(in: .whitespacesAndNewlines)
    let conf = [embedder.base, embedder.model ?? "", String(rerank), rerankModel]
    if Self.rerankGate.settings != conf { Self.rerankGate = (conf, RerankGate()) }
    let docs = Task.detached { Meaning.docs(await sources.value, vault: vault, here: here) }
    // the key goes to the service in this request only
    let synced = Task.detached { try await index.sync(await docs.value, embedder: embedder) }
    s.onMeaning = { q, thisBoard, reply in
      let src = await sources.value
      let d = await docs.value
      let found = BoardSearch.search(q, in: src, here: here, thisBoard: thisBoard)
      _ = try? await synced.value
      let a: Meaning.Answer
      do {
        a = try await Meaning.search(
          q, index: index, docs: d, embedder: embedder, here: here, onlyHere: thisBoard, found: found)
      } catch {
        return await reply(.init(items: [], error: Self.meaningError(error)))
      }
      await reply(
        .init(items: Meaning.items(a.rows, in: src, here: here), left: a.left > 0 ? a.left : nil, error: a.error))
      guard rerank, a.left == 0, !a.rows.isEmpty, Self.rerankGate.gate.open else { return }
      do {
        let r = try await Meaning.rerank(
          q, index: index, docs: d, here: here, onlyHere: thisBoard, found: found,
          model: rerankModel.isEmpty ? nil : rerankModel)
        if !r.isEmpty { await reply(.init(items: Meaning.items(r, in: src, here: here), ranked: true)) }
      } catch {
        // the server has no reranking model: not asked again until the settings change; another error: the order
        // by meaning stays
        if Self.rerankGate.settings == conf { _ = Self.rerankGate.gate.answered(error) }
      }
    }
  }

  /// What the group's error line says
  static func meaningError(_ e: Error) -> String {
    switch e as? BoxError {
    case .unavailable?:
      #if arch(arm64)
        let arch = "arm64"
      #else
        let arch = "x64"
      #endif
      return
        "Related by Meaning needs box, the index service, which this build of CodeBoard does not include for darwin-\(arch)."
    case .didNotStart(let m)?: return "box did not start: \(m)"
    case .timedOut?: return "box took too long to answer"
    case .closed?: return "box closed the connection"
    case .service(let m)?, .io(let m)?: return m
    case nil: return e.localizedDescription
    }
  }

  /// Closes it, the keys back on the board
  func closeSearch() {
    let s = Self.search
    // open over this window's boards, not another's
    guard s.isOpen, s.view.isDescendant(of: self) else { return }
    let had = window?.firstResponder === s.view
    s.close()
    if had, let pane = frontPane { window?.makeFirstResponder(pane.canvas) }
  }

  private func picked(_ p: SearchPanel.Pick) {
    closeSearch()
    guard let pane = frontPane else { return }
    guard p.board == pane.document?.id else {
      // the canvas's way to another board: it opens in this tab, then goes to the card
      pane.canvas.onOpenBoard?(p.board, .card(p.card))
      return
    }
    pane.canvas.arrive(at: p.card)
  }
}
