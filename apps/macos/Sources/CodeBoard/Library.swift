// The library window the app opens to: every project's boards (Projects.swift finds them) in a sidebar of projects and a grid of
// boards with their name, cards, when they were last edited and a thumbnail (Thumbs.swift); double-click opens the board in its own window. New Board, rename and delete (to the storage folder's
// .trash) go through the host's Storage (js/library.ts) on the shared bridge's Folder, the same as in the extension; its "boards" event:
// what another window or VS Code writes shows here, and ⌘K's index catches up.
import AppKit
import SwiftUI

struct LibBoard: Decodable, Identifiable, Hashable {
  var id: String
  var name: String
  var group: String?
  var cards: Int
  var file: String?
  var mtime: Double
}

/** A board somewhere in the library */
struct BoardRef: Hashable, Codable {
  var dir: String
  var id: String
}

enum Sel: Hashable {
  case recent
  case project(String)
}

@MainActor
final class LibraryModel: ObservableObject {
  @Published var projects: [Project] = []
  @Published var boards: [String: [LibBoard]] = [:]
  @Published var selection: Sel? = .recent
  @Published var picked: BoardRef?
  @Published var recents: [BoardRef] = []
  let lib: JSBridge
  let search: SearchIndex
  var open: (BoardRef) -> Void = { _ in }
  var closeBoard: (BoardRef, @escaping () -> Void) -> Void = { _, done in done() }
  private let only: String?
  private var folders: [String: Folder] = [:]
  private var listing: [String: Bool] = [:]
  /** The first full listing was drawn (the checks' library open time) */
  var onListed: (() -> Void)?
  private var listed = false

  init(lib: JSBridge, search: SearchIndex, only: String?) {
    self.lib = lib
    self.search = search
    self.only = only
    recents = (try? JSONDecoder().decode([BoardRef].self, from: UserDefaults.standard.data(forKey: "recentBoards") ?? Data())) ?? []
    if only != nil { recents = [] }
    NotificationCenter.default.addObserver(forName: .codeboardSettings, object: nil, queue: .main) { [weak self] n in
      if n.object as? String == "libraryFolders" { self?.reload() }
    }
  }

  func reload() {
    let ps = Projects.discover(only: only)
    let gone = Set(projects.map(\.dir)).subtracting(ps.map(\.dir))
    projects = ps
    for d in gone { boards[d] = nil; search.forget(d) }
    if case .project(let d) = selection, !ps.contains(where: { $0.dir == d }) { selection = ps.first.map { .project($0.dir) } ?? .recent }
    if only != nil, let p = ps.first { selection = .project(p.dir) }
    // each project's Folder on the shared bridge: its Storage watches the folder, its "boards" event says what changed
    for d in gone { folders.removeValue(forKey: d).map { $0.unlisten(self); $0.release() } }
    for p in ps where folders[p.dir] == nil {
      let f = lib.folder(p.dir)
      f.listen(self) { [weak self] name, _, _ in
        guard name == "boards", let self else { return }
        self.refresh(p.dir)
        self.search.soon(p.dir)
      }
      folders[p.dir] = f
    }
    var left = ps.count
    if left == 0 { listedAll() }
    for p in ps {
      refresh(p.dir) {
        left -= 1
        if left == 0 { self.listedAll() }
      }
      search.soon(p.dir, after: 0.5)
    }
  }
  private func listedAll() {
    guard !listed else { return }
    listed = true
    recents = recents.filter { r in boards[r.dir]?.contains { $0.id == r.id } == true }
    onListed?()
  }

  func refresh(_ dir: String, _ done: (() -> Void)? = nil) {
    lib.lib("list", [dir], [LibBoard].self) { [weak self] r in
      guard let self else { return }
      if case .success(let list) = r { self.boards[dir] = list.sorted { $0.mtime > $1.mtime } } else { logLine("[codeboard library] list %@: %@", dir, "\(r)") }
      done?()
    }
  }

  func project(_ dir: String) -> Project? {
    projects.first { $0.dir == dir } ?? projects.first { real($0.dir) == real(dir) }
  }
  /** Where a project is, for the subtitle: ~/… , or only the folder's name for a temporary folder */
  func place(_ p: Project) -> String {
    let f = p.folders.first ?? p.dir
    let tmp = [NSTemporaryDirectory(), "/tmp/", "/private/tmp/", "/private/var/folders/", "/var/folders/"]
    return tmp.contains { f.hasPrefix($0) } ? (f as NSString).lastPathComponent : f.abbreviatingWithTilde
  }
  func board(_ r: BoardRef) -> LibBoard? { boards[r.dir]?.first { $0.id == r.id } }
  var all: [(dir: String, project: String, id: String, name: String)] {
    projects.flatMap { p in (boards[p.dir] ?? []).map { (p.dir, p.name, $0.id, $0.name) } }
  }

  func opened(_ r: BoardRef) {
    guard only == nil else { return }
    recents = [r] + recents.filter { $0 != r }.prefix(23)
    UserDefaults.standard.set(try? JSONEncoder().encode(recents), forKey: "recentBoards")
  }

  // MARK: board actions
  var currentDir: String? {
    if case .project(let d) = selection { return d }
    return picked?.dir ?? projects.first?.dir
  }
  func newBoard(in dir: String? = nil) {
    guard let dir = dir ?? currentDir else { return }
    lib.lib("create", [dir, "Untitled Board"], String.self) { [weak self] r in
      guard let self, case .success(let id) = r else { return }
      self.refresh(dir) {
        let ref = BoardRef(dir: dir, id: id)
        self.picked = ref
        self.renaming = ref
      }
    }
  }
  @Published var renaming: BoardRef?
  @Published var deleting: BoardRef?
  func rename(_ r: BoardRef, _ name: String) {
    let n = name.trimmingCharacters(in: .whitespaces)
    guard !n.isEmpty, n != board(r)?.name else { return }
    lib.lib("rename", [r.dir, r.id, n], String?.self) { [weak self] _ in self?.refresh(r.dir) }
  }
  func delete(_ r: BoardRef) {
    closeBoard(r) {
      self.lib.lib("remove", [r.dir, r.id], String?.self) { [weak self] _ in
        guard let self else { return }
        self.recents.removeAll { $0 == r }
        if self.picked == r { self.picked = nil }
        self.refresh(r.dir)
      }
    }
  }
  /** A folder joins the library. One with no boards anywhere gets a .codeboard/ only when the user says so (as Move Boards
   *  into Project does in the extension): never board files in the repository's root */
  func addFolder(_ f: String) {
    var dir = Projects.boardsFolder(f)
    if dir == nil {
      let a = NSAlert()
      a.messageText = "Keep boards for “\(Projects.nameOf(f))” in the project?"
      a.informativeText = "CodeBoard makes a .codeboard folder in \((f as String).abbreviatingWithTilde) for its boards, as Move Boards into Project does in VS Code."
      a.addButton(withTitle: "Make .codeboard")
      a.addButton(withTitle: "Cancel")
      guard a.runModal() == .alertFirstButtonReturn else { return }
      let p = (f as NSString).appendingPathComponent(".codeboard")
      try? FileManager.default.createDirectory(atPath: p, withIntermediateDirectories: true)
      dir = p
    }
    if !Projects.added.contains(f) { Projects.added = Projects.added + [f] }
    reload()
    selection = .project(dir!)
  }

}

// MARK: views

struct LibraryView: View {
  @ObservedObject var m: LibraryModel
  @ObservedObject private var look = Look.shared

  var body: some View {
    let ch = look.chrome
    NavigationSplitView {
      List(selection: $m.selection) {
        Section("Library") {
          row("Recent", "clock", .recent)
        }
        Section("Projects") {
          ForEach(m.projects) { p in
            row(p.name, p.dir.hasSuffix("/.codeboard") ? "folder" : "tray.full", .project(p.dir))
              .badge(m.boards[p.dir]?.count ?? 0)
              .help(m.place(p))
              .contextMenu {
                Button("New Board") { m.newBoard(in: p.dir) }
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p.dir)]) }
              }
          }
        }
      }
      .listStyle(.sidebar)
      .scrollContentBackground(ch.sidebar == nil ? .automatic : .hidden)
      .background(ch.sidebar.map { Color(nsColor: $0) } ?? .clear)
      .navigationSplitViewColumnWidth(min: Design.sidebarWidth.min, ideal: Design.sidebarWidth.ideal, max: Design.sidebarWidth.max)
    } detail: {
      detail
        .background(ch.content.color)
        .navigationTitle(title)
        .navigationSubtitle(subtitle)
        .toolbar {
          ToolbarItem(placement: .primaryAction) {
            Button { NSApp.sendAction(#selector(AppDelegate.showSearch(_:)), to: nil, from: nil) } label: {
              Label("Search All Boards", systemImage: "magnifyingglass").labelStyle(.titleAndIcon)
                .frame(width: Design.searchFieldWidth, alignment: .leading)
            }
            .help("Search All Boards (⌘K)")
          }
          .sharedBackgroundVisibility(ch.glass ? .automatic : .hidden)
          ToolbarItem(placement: .primaryAction) {
            Button { m.newBoard() } label: { Label("New Board", systemImage: "plus") }
              .buttonStyle(.borderedProminent)
              .disabled(m.currentDir == nil).help("New Board (⌘N)")
          }
          .sharedBackgroundVisibility(ch.glass ? .automatic : .hidden)
        }
        .toolbarBackground(ch.toolbar.map { Color(nsColor: $0) } ?? .clear, for: .windowToolbar)
        .toolbarBackgroundVisibility(ch.toolbar == nil ? .automatic : .visible, for: .windowToolbar)
    }
    .tint(ch.accent.color)
    .confirmationDialog(
      "Move “\(m.deleting.flatMap { m.board($0)?.name } ?? "")” to the Trash?",
      isPresented: Binding(get: { m.deleting != nil }, set: { if !$0 { m.deleting = nil } })
    ) {
      Button("Move to Trash", role: .destructive) { if let r = m.deleting { m.delete(r) } }
    } message: {
      Text("It goes to the .trash folder of the project's boards, where it can be brought back by hand.")
    }
  }

  private func row(_ name: String, _ symbol: String, _ tag: Sel) -> some View {
    Label(name, systemImage: symbol).fontWeight(m.selection == tag ? .semibold : .regular).tag(tag)
  }

  private var refs: [BoardRef] {
    switch m.selection {
    case .project(let d): return (m.boards[d] ?? []).map { BoardRef(dir: d, id: $0.id) }
    default: return m.recents
    }
  }
  private var title: String {
    if case .project(let d) = m.selection { return m.project(d)?.name ?? "Boards" }
    return "Recent"
  }
  private var subtitle: String {
    let n = refs.count
    let s = "\(n) board\(n == 1 ? "" : "s")"
    if case .project(let d) = m.selection, let p = m.project(d) { return s + " · " + m.place(p) }
    return s
  }

  /** Today, This Week, Earlier by when each board changed (Recent keeps the order they were opened in) */
  private var groups: [(String, [BoardRef])] {
    guard m.selection != .recent else { return [("", refs)] }
    let cal = Calendar.current, now = Date()
    let week = cal.dateInterval(of: .weekOfYear, for: now)?.start ?? now
    var g: [String: [BoardRef]] = [:]
    for r in refs {
      let d = Date(timeIntervalSince1970: (m.board(r)?.mtime ?? 0) / 1000)
      g[cal.isDateInToday(d) ? "Today" : d >= week ? "This Week" : "Earlier", default: []].append(r)
    }
    return ["Today", "This Week", "Earlier"].compactMap { k in g[k].map { (k, $0) } }
  }

  @ViewBuilder private var detail: some View {
    if refs.isEmpty {
      ContentUnavailableView(m.selection == .recent ? "No Recent Boards" : "No Boards", systemImage: "rectangle.on.rectangle",
                             description: Text(m.selection == .recent ? "Boards you open show up here." : "Make one with New Board (⌘N)."))
    } else {
      ScrollView {
        VStack(alignment: .leading, spacing: Design.groupGap) {
          ForEach(groups, id: \.0) { name, rs in
            VStack(alignment: .leading, spacing: Design.gridRowSpacing) {
              if !name.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                  Text(name).font(Design.groupFont)
                  Text("\(rs.count)").font(Design.groupCountFont).foregroundStyle(.secondary)
                }
              }
              LazyVGrid(columns: [GridItem(.adaptive(minimum: Design.tileMin, maximum: Design.tileMax), spacing: Design.gridSpacing)],
                        alignment: .leading, spacing: Design.gridRowSpacing) {
                ForEach(rs, id: \.self) { r in
                  if let b = m.board(r) { BoardTile(board: b, ref: r, caption: caption(r, b), m: m) }
                }
              }
            }
          }
        }
        .padding(Design.gridPadding)
      }
      .scrollEdgeEffectStyle(.soft, for: .top)
      .background(Color.clear.contentShape(Rectangle()).onTapGesture { m.picked = nil; m.renaming = nil })
    }
  }

  private func caption(_ r: BoardRef, _ b: LibBoard) -> String {
    let when = b.mtime > 0 ? RelativeDateTimeFormatter().localizedString(for: Date(timeIntervalSince1970: b.mtime / 1000), relativeTo: Date()) : ""
    var s = "\(b.cards) card\(b.cards == 1 ? "" : "s") · \(when)"
    if m.selection == .recent, let p = m.project(r.dir) { s = "\(p.name) · " + s }
    return s
  }
}

/** A board in the grid: its thumbnail (a ring when picked, a ··· menu on hover), its name (a pill when picked; click it again
 *  to rename in place, as in Finder) and when it changed */
struct BoardTile: View {
  var board: LibBoard
  var ref: BoardRef
  var caption: String
  @ObservedObject var m: LibraryModel
  @ObservedObject private var look = Look.shared
  @State private var hover = false
  @State private var name = ""
  @FocusState private var editing: Bool

  var body: some View {
    let ch = look.chrome
    let selected = m.picked == ref
    VStack(alignment: .leading, spacing: Design.tileTextGap) {
      BoardThumb(ref: ref, lib: m.lib, key: "\(ref.dir)|\(ref.id)|\(board.mtime)")
        .aspectRatio(Design.thumbAspect, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: Design.thumbRadius))
        .overlay(RoundedRectangle(cornerRadius: Design.thumbRadius).strokeBorder(ch.hair.color, lineWidth: 0.5))
        .shadow(color: .black.opacity(Design.thumbShadow.opacity), radius: Design.thumbShadow.radius, y: Design.thumbShadow.y)
        .overlay(alignment: .topTrailing) { more(ch).opacity(hover ? 1 : 0).animation(.easeOut(duration: Design.moreFade), value: hover) }
        .padding(Design.selectionGap)
        .overlay(
          RoundedRectangle(cornerRadius: Design.thumbRadius + Design.selectionGap)
            .strokeBorder(ch.accent.color, lineWidth: Design.selectionWidth)
            .padding(-Design.selectionWidth)
            .opacity(selected ? 1 : 0)
        )
        .padding(.bottom, Design.tileNameGap - Design.tileTextGap)
        .onTapGesture(count: 2) { m.open(ref) }
        .simultaneousGesture(TapGesture().onEnded { m.picked = ref; m.renaming = nil })
      if m.renaming == ref {
        TextField("Name", text: $name)
          .font(Design.tileNameFont).textFieldStyle(.roundedBorder)
          .focused($editing)
          .onAppear { name = board.name; editing = true }
          .onSubmit { m.rename(ref, name); m.renaming = nil }
          .onExitCommand { m.renaming = nil }
          .onChange(of: editing) { _, on in if !on, m.renaming == ref { m.rename(ref, name); m.renaming = nil } }
      } else {
        Text(board.name).font(Design.tileNameFont).lineLimit(1)
          .foregroundStyle(selected ? Color.white : Color.primary)
          .padding(.horizontal, Design.selectionGap * 2)
          .background(RoundedRectangle(cornerRadius: Design.namePillRadius).fill(selected ? ch.accent.color : .clear))
          .onTapGesture { if selected { m.renaming = ref } else { m.picked = ref } }
      }
      Text(caption).font(Design.tileMetaFont).foregroundStyle(.secondary).lineLimit(1).padding(.horizontal, Design.selectionGap * 2)
    }
    .onHover { hover = $0 }
    .contextMenu { menu }
    .accessibilityLabel(board.name)
  }

  @ViewBuilder private var menu: some View {
    Button("Open") { m.open(ref) }
    Button("Rename") { m.picked = ref; m.renaming = ref }
    if let f = board.file { Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: f)]) } }
    Divider()
    Button("Move to Trash", role: .destructive) { m.deleting = ref }
  }

  @ViewBuilder private func more(_ ch: Chrome) -> some View {
    let b = Menu { menu } label: { Image(systemName: "ellipsis").frame(width: Design.moreButton, height: Design.moreButton) }
      .menuStyle(.button).menuIndicator(.hidden).buttonStyle(.plain)
    Group {
      if ch.glass {
        b.glassEffect(ch.swiftUIGlass, in: .circle)
      } else {
        b.background(Circle().fill(ch.surface.color)).overlay(Circle().strokeBorder(ch.hair.color, lineWidth: 0.5))
      }
    }
    .padding(8)
  }
}

/** The path with symlinks resolved (/tmp and /private/tmp are one folder) */
func real(_ p: String) -> String { URL(fileURLWithPath: p).resolvingSymlinksInPath().path }

extension String {
  var abbreviatingWithTilde: String { (self as NSString).abbreviatingWithTildeInPath }
}

final class LibraryWindowController: NSWindowController, NSWindowDelegate {
  let model: LibraryModel
  init(model: LibraryModel) {
    self.model = model
    let host = NSHostingController(rootView: LibraryView(m: model))
    host.sceneBridgingOptions = [.toolbars, .title]
    let w = NSWindow(contentViewController: host)
    w.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
    w.toolbarStyle = .unified
    w.setContentSize(Design.libraryDefault)
    w.minSize = Design.libraryMin
    w.title = "Library"
    w.setFrameAutosaveName("CodeBoard.library")
    if !w.setFrameUsingName("CodeBoard.library") { w.center() }
    super.init(window: w)
    w.delegate = self
    // a toolbar of its own: SwiftUI fills it (sceneBridgingOptions), the title bar stays unified glass
    w.toolbar = NSToolbar(identifier: "CodeBoard.library")
  }
  required init?(coder: NSCoder) { fatalError() }

  /** Delete (⌫) moves the picked board to the Trash, Return opens it */
  override func keyDown(with e: NSEvent) {
    guard let r = model.picked else { return super.keyDown(with: e) }
    switch e.keyCode {
    case 51, 117: model.deleting = r
    case 36, 76: model.open(r)
    default: super.keyDown(with: e)
    }
  }
}
