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

  /// Follows the tabs: new tabs get a canvas, closed tabs lose theirs, a tab now on another board loads it.
  /// `reload` reads every open board again (the vault changed on disk).
  func sync(reload: Bool = false) {
    let live = Set(shell.tabs.map(\.id))
    for (id, pane) in panes where !live.contains(id) {
      pane.removeFromSuperview()
      panes[id] = nil
    }
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
      if reload || pane.board?.id != tab.board, let vault = shell.vault, let at = shell.board(tab.board) {
        pane.load(at, in: vault, theme: theme)
      } else {
        pane.restyle(theme)
      }
    }
    reveal()
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
  private(set) var board: Board?
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
    guard !theme.same(as: canvas.currentTheme), board != nil else { return }
    Task {
      do { try await canvas.show(theme: theme) } catch { fail(error) }
    }
  }

  /// Hands the board to the canvas only when it or the theme changed, or shows why it cannot be read
  func load(_ at: VaultBoard, in vault: Vault, theme: Theme) {
    self.theme = theme
    // ponytail: reads board.json on the main thread to see whether it changed (the canvas reads it again off it);
    // move off it if large boards stall a tab switch
    do {
      let new = try vault.board(at: at.path)
      problem.isHidden = true
      canvas.isHidden = false
      guard new != board else { return restyle(theme) }
      board = new
      if !ready {
        Task { [weak self] in
          try? await Task.sleep(for: Self.patience)
          self?.becomeReady()
        }
      }
      Task {
        do { try await canvas.show(at, in: vault, theme: theme) } catch { fail(error) }
        becomeReady()
        // the theme changed while the board was loading
        restyle(self.theme)
      }
    } catch {
      fail(error)
      becomeReady()
    }
  }

  private func becomeReady() {
    guard !ready else { return }
    ready = true
    onReady?()
  }

  private func fail(_ error: any Error) {
    problem.stringValue = String(describing: error)
    problem.isHidden = false
    canvas.isHidden = true
  }
}
