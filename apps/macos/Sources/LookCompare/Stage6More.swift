import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes
import CodeBoardShell
import SwiftUI

// The rest of stage 6's sheets: the sidebar in each of its states, the menus, a folder board, seals on refs, the seal
// popover and the back button. Made-up names, some Chinese.

extension Stage6Sheets {
  static func note(_ id: String, x: Double, y: Double, w: Double = 360, _ text: String) -> Card {
    Card(id: cid(id), x: x, y: y, width: w, content: .own(CardContent(body: .note(Note(text: text)))))
  }

  static let prefill = BoardID(rawValue: "sb-prefill")
  static let decode = BoardID(rawValue: "sb-decode")
  static let flash = BoardID(rawValue: "sb-flash")

  /// The vault the sidebar shows
  static func sidebarVault(_ root: URL) throws -> Vault {
    let fm = FileManager.default
    try? fm.removeItem(at: root)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    let v = Vault(root: root)
    try v.newFolder(in: "", name: "调度 Scheduler")
    try v.newFolderBoard(in: "调度 Scheduler")
    try v.newBoard(in: "调度 Scheduler", title: "Prefill 预填充", board: Board(id: prefill))
    try v.newBoard(in: "调度 Scheduler", title: "Decode Loop", board: Board(id: decode, seal: Seal(text: "DL")))
    try v.newBoard(in: "调度 Scheduler", title: "注意力", board: Board(id: BoardID(rawValue: "sb-attn")))
    try v.newFolder(in: "调度 Scheduler", name: "Kernels")
    try v.newBoard(in: "调度 Scheduler/Kernels", title: "Flash Attention", board: Board(id: flash))
    try v.newFolder(in: "", name: "Notes")
    try v.newBoard(in: "Notes", title: "Reading List", board: Board(id: BoardID(rawValue: "sb-reading")))
    try v.newBoard(in: "", title: "Overview", board: Board(id: BoardID(rawValue: "sb-overview")))
    try v.newBoard(
      in: "", title: "Paged KV Cache with a long name that does not fit",
      board: Board(id: BoardID(rawValue: "sb-kv"), seal: Seal(color: .plum)))
    return v
  }

  @MainActor static func sidebars(out: URL, root: URL) throws -> [String] {
    let vault = try sidebarVault(root.appending(path: "sidebar"))
    let tree = try vault.tree()
    let overview = try require(tree.boards.first { $0.title == "Overview" })
    let kv = try require(tree.boards.first { $0.title.hasPrefix("Paged") })
    var lines: [String] = []
    for dark in [false, true] {
      func shell() -> Shell {
        let s = Shell()
        s.open(vault, restoring: nil)
        s.apply(.success(tree))
        s.expanded = ["调度 Scheduler", "调度 Scheduler/Kernels", "Notes"]
        s.show(overview.id)
        return s
      }
      var cuts: [CGImage] = []
      func add(_ s: Shell, width: CGFloat = 244) {
        if let img = ShellPictures.sidebar(s, width: width, height: 420, dark: dark) { cuts.append(img) }
      }
      add(shell())
      let hover = shell()
      hover.hoveredRow = Shell.rowKey(board: prefill)
      add(hover)
      let folder = shell()
      folder.hoveredRow = Shell.rowKey(folder: "Notes")
      add(folder)
      let own = shell()
      own.hoveredRow = Shell.rowKey(folder: "调度 Scheduler")
      add(own)
      let rootHover = shell()
      rootHover.hoveredRow = Shell.rowKey(folder: "")
      add(rootHover)
      let renaming = shell()
      renaming.renaming = .board(kv.id)
      add(renaming)
      let open = shell()
      open.show(decode)
      add(open)
      add(shell(), width: 180)
      add(shell(), width: 400)
      EditSheets.write(
        try WritingSheets.row(cuts, theme: Theme.named(.warmInk, dark: dark)), out, "sidebar-\(dark ? "dark" : "light")"
      )
    }
    lines.append(
      "sidebar-light.png, sidebar-dark.png: left to right at 244 pt: at rest (Overview open); a board row hovered (Prefill 预填充);"
        + " a folder without a folder board hovered (Notes: + board, new folder, board icon); a folder with one hovered"
        + " (调度 Scheduler: + and new folder, its seal solid); the vault's row hovered; renaming a board in place;"
        + " Decode Loop open; then at rest at 180 pt (narrow) and 400 pt (wide)")
    // the seal popover: default, edited, the clash line
    for dark in [false, true] {
      let pops = [
        SealEditor(
          id: prefill, name: "Prefill 预填充", seal: nil, clash: { _, _ in nil }, apply: { _, _ in }, dismiss: {}),
        SealEditor(
          id: prefill, name: "Prefill 预填充", seal: Seal(text: "调度", color: .teal), clash: { _, _ in nil },
          apply: { _, _ in }, dismiss: {}),
        SealEditor(
          id: prefill, name: "Prefill 预填充", seal: Seal(text: "DL", color: Seal.defaultColor(decode)),
          clash: { _, _ in "Decode Loop" }, apply: { _, _ in }, dismiss: {}),
      ].compactMap { e in
        ShellPictures.draw(
          e.background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .windowBackgroundColor)))
            .padding(10), dark: dark)
      }
      EditSheets.write(
        try WritingSheets.row(pops, theme: Theme.named(.warmInk, dark: dark)), out,
        "seal-popover-\(dark ? "dark" : "light")")
    }
    lines.append(
      "seal-popover-light.png, seal-popover-dark.png: the Edit Mark… popover's content (drawn on a plain rounded sheet;"
        + " the system popover's material and arrow are not drawn off screen): its default (placeholder = the default"
        + " text), edited (调度, teal), and a seal another board in the same book has (the one line under it)")
    // the back button, with somewhere to go back to
    for dark in [false, true] {
      let s = shell(vault, tree, overview)
      s.show(prefill)
      let none = shell(vault, tree, overview)
      let pics = [ShellPictures.titleControls(none, dark: dark), ShellPictures.titleControls(s, dark: dark)]
        .compactMap { $0 }
      EditSheets.write(
        try WritingSheets.row(pics, theme: Theme.named(.warmInk, dark: dark)), out, "back-\(dark ? "dark" : "light")")
    }
    lines.append(
      "back-light.png, back-dark.png: sidebar toggle, back and forward: nothing to go back to, then back enabled after"
        + " a sub-board card was opened in the tab")
    // the row menus, as their items
    let s = shell(vault, tree, overview)
    let fb = try require(tree.folder(at: "调度 Scheduler"))
    let notes = try require(tree.folder(at: "Notes"))
    let menus: [(String, [String?])] = [
      ("folder with a folder board", s.menu(folder: fb).map { $0?.title }),
      ("folder without one", s.menu(folder: notes).map { $0?.title }),
      ("board", s.menu(board: overview).map { $0?.title }),
    ]
    rowMenus = menus
    return lines
  }

  @MainActor static func shell(_ vault: Vault, _ tree: VaultFolder, _ first: VaultBoard) -> Shell {
    let s = Shell()
    s.open(vault, restoring: nil)
    s.apply(.success(tree))
    s.show(first.id)
    return s
  }

  /// The sidebar's menus, kept for the menus sheet
  @MainActor static var rowMenus: [(String, [String?])] = []

  /// A menu drawn as its items (the system's menu is not drawn off screen)
  struct MenuPicture: View {
    let title: String
    let items: [String?]

    var body: some View {
      VStack(alignment: .leading, spacing: 6) {
        Text(title).font(.system(size: 11)).foregroundStyle(.secondary)
        VStack(alignment: .leading, spacing: 0) {
          ForEach(items.indices, id: \.self) { i in
            if let t = items[i] {
              Text(t).font(.system(size: 13)).padding(.horizontal, 12).frame(height: 22, alignment: .leading)
            } else {
              Divider().padding(.vertical, 5).padding(.horizontal, 10)
            }
          }
        }
        .padding(.vertical, 5)
        .frame(minWidth: 190, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .windowBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.12)))
      }
      .padding(8)
    }
  }

  static func titles(_ m: NSMenu?) -> [String?] {
    (m?.items ?? []).map { i in i.isSeparatorItem ? nil : i.submenu == nil ? i.title : i.title + " ▸" }
  }

  /// A right-click at a board point of the canvas: the menu it gets
  @MainActor static func menu(_ r: Rig, at p: CGPoint) -> NSMenu? {
    let v = r.canvas.viewPoint(p)
    let w = r.canvas.convert(v, to: nil)
    guard
      let e = NSEvent.mouseEvent(
        with: .rightMouseDown, location: w, modifierFlags: [], timestamp: 0, windowNumber: r.window.windowNumber,
        context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
    else { return nil }
    return r.canvas.menu(for: e)
  }

  /// A folder board: its automatic cards (two boards and a subfolder) and the user's own Note, Section and arrow; and
  /// a board in one book with refs to boards in the same book, in another and at the top
  @MainActor static func boards(out: URL, root: URL, notes: NoteRenderer) async throws -> [String] {
    var lines: [String] = []
    var canvasMenus: [(String, [String?])] = []
    for theme in Theme.all.flatMap({ [$0, Theme.named($0.id, dark: true)] }) {
      let suffix = theme.id.rawValue + (theme.dark ? "-dark" : "")
      var folder = Board(
        id: BoardID(rawValue: "sb-fb"),
        cards: [note("mine", x: -520, y: 40, w: 380, "## 调度怎么走\n\n先 **prefill**，再一步步 decode。")],
        sections: [
          Section(
            id: SectionID(rawValue: "s-mine"), title: "Reading 先读", x: -560, y: -20, width: 460, height: 360,
            color: "sand")
        ])
      folder.keepUp(with: [.board(prefill), .board(decode), .folder("Kernels")])
      let first = try require(folder.autoCards.first?.card.id)
      folder.arrows = [Arrow(id: ArrowID(rawValue: "a1"), from: Endpoint(card: cid("mine")), to: Endpoint(card: first))]
      let r = try await Rig(
        root: root.appending(path: "fb"), notes: notes, theme: theme, zoom: 0.5, board: folder,
        others: [
          (
            "调度 Scheduler/Prefill 预填充",
            {
              var b = scheduler()
              b.id = prefill
              return b
            }()
          ),
          (
            "调度 Scheduler/Decode Loop",
            Board(id: decode, cards: [note("d1", x: 0, y: 0, "decode"), note("d2", x: 500, y: 0, "step")])
          ),
          ("调度 Scheduler/Kernels/Flash Attention", Board(id: flash)),
        ], size: size, centre: CGPoint(x: 300, y: 260), sheet: "调度 Scheduler/.folder")
      r.canvas.vaultChanged()
      await r.canvas.drawAll()
      EditSheets.write(try cut(r, CGRect(origin: .zero, size: size)), out, "folder-board-\(suffix)")
      if !theme.dark, theme.id == .warmInk {
        let auto = try require(r.doc.board.card(first))
        canvasMenus.append(
          ("an automatic card", titles(menu(r, at: CGPoint(x: auto.x + 40, y: auto.y + 40)))))
        canvasMenus.append(("the user's own Note", titles(menu(r, at: CGPoint(x: -500, y: 60)))))
      }
      r.close()

      // refs: this board is in the book 调度 Scheduler
      let sheet = Board(
        id: BoardID(rawValue: "sb-sheet"),
        cards: [
          note(
            "refs", x: 0, y: 0, w: 460,
            "### Refs 引用\n\nSame book 同一本书: [[Prefill 预填充]]\n\nCJK seal: [[注意力]]\n\n"
              + "Another book 另一本: [[Scheduler Core]]\n\nA top-level board: [[Overview]]")
        ])
      let rr = try await Rig(
        root: root.appending(path: "refs"), notes: notes, theme: theme, zoom: 1.6, board: sheet,
        others: [
          ("调度 Scheduler/.folder", Board(id: BoardID(rawValue: "sb-fb"))),
          ("调度 Scheduler/Prefill 预填充", Board(id: prefill)),
          ("调度 Scheduler/注意力", Board(id: BoardID(rawValue: "sb-attn"))),
          ("Engine 引擎/.folder", Board(id: BoardID(rawValue: "sb-engine"), seal: Seal(text: "ENG", color: .olive))),
          ("Engine 引擎/Scheduler Core", Board(id: BoardID(rawValue: "sb-core"))),
          ("Overview", Board(id: BoardID(rawValue: "sb-overview"), seal: Seal(text: "OV", color: .plum))),
        ], size: CGSize(width: 900, height: 560), centre: CGPoint(x: 230, y: 130), sheet: "调度 Scheduler/Sheet")
      rr.canvas.vaultChanged()
      await rr.canvas.drawAll()
      await rr.until { rr.canvas.refPoints(on: cid("refs")).count == 4 }
      EditSheets.write(try cut(rr, CGRect(x: 0, y: 0, width: 900, height: 560)), out, "ref-seals-\(suffix)")
      if !theme.dark, theme.id == .warmInk, let p = rr.canvas.refPoints(on: cid("refs")).first {
        canvasMenus.append(("a ref to another board", titles(menu(rr, at: p))))
      }
      rr.close()
    }
    lines.append(
      "folder-board-<theme>.png: the folder board of 调度 Scheduler: its automatic cards (Prefill 预填充, Decode Loop,"
        + " the subfolder Kernels, which has no folder board, so its map is empty) after one another, and the user's own"
        + " Section, Note and an arrow to the first card, kept")
    lines.append(
      "ref-seals-<theme>.png: a Note on a board in the book 调度 Scheduler with refs to a board in the same book (its"
        + " seal only), to one with a CJK seal (not trimmed to cap height, one size larger), to a board in another book"
        + " (Engine 引擎's seal in front, two halves) and to a top-level board, a book itself: its seal alone, no"
        + " title, as main draws a ref to a book (md/refs.ts sealFor)")
    for dark in [false, true] {
      let pics = (rowMenus + canvasMenus).compactMap {
        ShellPictures.draw(MenuPicture(title: $0.0, items: $0.1), dark: dark)
      }
      EditSheets.write(
        try WritingSheets.row(pics, theme: Theme.named(.warmInk, dark: dark)), out, "menus-\(dark ? "dark" : "light")")
    }
    lines.append(
      "menus-light.png, menus-dark.png: each context menu as its items, read from the menus the app builds (the sidebar's"
        + " row menus and the canvas's menu(for:)); drawn as a list, not the system menu")
    return lines
  }
}

private func require<T>(_ v: T?, _ what: String = "value") throws -> T {
  guard let v else { throw CocoaError(.featureUnsupported) }
  return v
}
