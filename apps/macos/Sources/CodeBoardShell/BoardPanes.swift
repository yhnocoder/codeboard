import AppKit
import CodeBoardCanvas
import CodeBoardModel

/// The single place a board reaches the canvas
@MainActor func show(_ board: Board, in canvas: CanvasView) {
  // ponytail: CanvasView has only init(frame:) yet; its show-a-board-with-a-theme call goes here when it lands
  _ = (board, canvas)
}

/// The board panel's content below the top bar: one canvas per tab, kept while the tab lives so switching back is
/// instant; only the selected tab's is visible
@MainActor final class BoardPanes: NSView {
  private let shell: Shell
  private var panes: [Tab.ID: Pane] = [:]

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
        addSubview(pane)
      }
      if reload || pane.board?.id != tab.board, let vault = shell.vault, let at = shell.board(tab.board) {
        pane.load { try vault.board(at: at.path) }
      }
      pane.isHidden = tab.id != shell.selected
    }
  }
}

private final class Pane: NSView {
  private(set) var board: Board?
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

  /// Hands the board to the canvas only when it changed, or shows why it cannot be read
  func load(_ read: () throws -> Board) {
    // ponytail: reads board.json on the main thread; move off it if large boards stall a tab switch
    do {
      let new = try read()
      problem.isHidden = true
      canvas.isHidden = false
      if new != board {
        board = new
        show(new, in: canvas)
      }
    } catch {
      problem.stringValue = String(describing: error)
      problem.isHidden = false
      canvas.isHidden = true
    }
  }
}
