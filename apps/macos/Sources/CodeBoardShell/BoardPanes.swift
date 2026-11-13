import AppKit
import CodeBoardCanvas
import CodeBoardModel

/// The board panel's content below the top bar: one canvas per tab, kept while the tab lives so switching back is
/// instant. One pane is on screen: the selected tab's once its board is drawn; until then the one before it stays, so
/// opening a tab never passes through an empty canvas
@MainActor final class BoardPanes: NSView {
  private let shell: Shell
  private var panes: [Tab.ID: Pane] = [:]
  private var front: Tab.ID?

  init(shell: Shell) {
    self.shell = shell
    super.init(frame: .zero)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("BoardPanes is not loaded from nibs")
  }

  /// Follows the tabs: new tabs get a canvas, closed tabs lose theirs (their board written first), a tab now on another
  /// board shows it. `reload`: the vault changed on disk, so every open board takes in what changed there.
  func sync(reload: Bool = false) {
    let live = Set(shell.tabs.map(\.id))
    for (id, pane) in panes where !live.contains(id) {
      pane.close()
      panes[id] = nil
    }
    if reload { for doc in documents.values { doc.diskChanged() } }
    for tab in shell.tabs {
      let pane = panes[tab.id] ?? Pane()
      if panes[tab.id] == nil {
        panes[tab.id] = pane
        pane.frame = bounds
        pane.autoresizingMask = [.width, .height]
        pane.isHidden = true
        pane.onReady = { [weak self] in self?.reveal() }
        addSubview(pane)
      }
      let theme = shell.look
      if let vault = shell.vault, let at = shell.board(tab.board),
        pane.document?.id != tab.board || pane.shown?.path != at.path || pane.failed && reload
      {
        do {
          pane.load(at, in: vault, theme: theme, document: try document(tab.board))
        } catch {
          pane.fail(error)
        }
      } else {
        pane.restyle(theme)
      }
    }
    reveal()
  }

  /// One document per board while the app runs, whichever tabs show it, so its undo history outlives tab switches
  private(set) var documents: [BoardID: BoardDocument] = [:]

  private func document(_ id: BoardID) throws -> BoardDocument {
    if let doc = documents[id] { return doc }
    // ponytail: reads board.json on the main thread when a board is first opened; move off it if large boards stall
    let doc = try BoardDocument { [weak shell] in
      guard let shell, let vault = shell.vault, let at = shell.board(id) else { return nil }
      return vault.url(of: at.path).appending(path: Vault.boardFileName)
    }
    documents[id] = doc
    return doc
  }

  /// Writes every board with changes not yet saved (quitting, another vault)
  func flush() {
    for doc in documents.values { doc.flush() }
  }

  /// Another vault: what was open is written and let go
  func close() {
    flush()
    documents = [:]
    for pane in panes.values { pane.close() }
    panes = [:]
  }

  private func reveal() {
    guard let selected = shell.selected, let pane = panes[selected] else { return place(nil) }
    if pane.ready || front.flatMap({ panes[$0] }) == nil { place(selected) }
  }

  private func place(_ id: Tab.ID?) {
    front = id
    for (tab, pane) in panes { pane.isHidden = tab != id }
  }
}

private final class Pane: NSView {
  private(set) var document: BoardDocument?
  /// Where the board shown is in the vault
  private(set) var shown: VaultBoard?
  private(set) var failed = false
  /// Whether it may come on screen: its first board is drawn or failed, or `patience` has passed, after which an empty
  /// canvas is better than a tab switch that seems ignored
  private(set) var ready = false
  var onReady: (() -> Void)?
  private static let patience = Duration.milliseconds(250)
  private let canvas = CanvasView()
  private let problem = NSTextField(wrappingLabelWithString: "")

  init() {
    super.init(frame: .zero)
    canvas.autoresizingMask = [.width, .height]
    addSubview(canvas)
    problem.textColor = .secondaryLabelColor
    problem.alignment = .center
    problem.isSelectable = true
    problem.isHidden = true
    problem.translatesAutoresizingMaskIntoConstraints = false
    addSubview(problem)
    NSLayoutConstraint.activate([
      problem.centerXAnchor.constraint(equalTo: centerXAnchor),
      problem.centerYAnchor.constraint(equalTo: centerYAnchor),
      problem.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -64),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("Pane is not loaded from nibs")
  }

  override func layout() {
    super.layout()
    canvas.frame = bounds
  }

  /// The theme the board is to be drawn in
  private var theme = Theme.warmInk

  /// Draws the board shown in another theme or appearance, where its camera is
  func restyle(_ theme: Theme) {
    self.theme = theme
    guard !theme.same(as: canvas.currentTheme), document != nil else { return }
    Task {
      do { try await canvas.show(theme: theme) } catch { fail(error) }
    }
  }

  /// Shows an open board and edits it there
  func load(_ at: VaultBoard, in vault: Vault, theme: Theme, document doc: BoardDocument) {
    self.theme = theme
    problem.isHidden = true
    canvas.isHidden = false
    failed = false
    document = doc
    shown = at
    if !ready {
      Task { [weak self] in
        try? await Task.sleep(for: Self.patience)
        self?.becomeReady()
      }
    }
    Task {
      do { try await canvas.show(doc, at: at, in: vault, theme: theme) } catch { fail(error) }
      becomeReady()
      // the theme changed while the board was loading
      restyle(self.theme)
    }
  }

  /// Its tab closed: the board is written and the canvas lets go of it
  func close() {
    document?.flush()
    canvas.leave()
    removeFromSuperview()
  }

  private func becomeReady() {
    guard !ready else { return }
    ready = true
    onReady?()
  }

  func fail(_ error: any Error) {
    failed = true
    document = nil
    shown = nil
    becomeReady()
    problem.stringValue = String(describing: error)
    problem.isHidden = false
    canvas.isHidden = true
  }
}
