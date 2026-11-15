import AppKit
import CodeBoardModel

/// Draws Notes into bitmaps through the Note page: from the disk cache when the Note was drawn before at that scale,
/// otherwise in the one web view, which is made when needed and closed after 30 s without a request. A Note mounted there
/// stays mounted (up to `NotePage.cap`, the least recently used going first), so a picture at another scale is a
/// snapshot of it, with nothing laid out again. Requests waiting for the web view go by priority and can be cancelled
/// (cancel the calling task). Letting go of the renderer closes the web view.
@MainActor
public final class NoteRenderer: NoteDisplay {
  /// The built Note page inside the app (Contents/Resources/NotePage), else `web/dist` in this package's source tree
  /// (`swift run`, `swift test`)
  public nonisolated static var bundledPage: URL {
    if let r = Bundle.main.resourceURL?.appending(path: "NotePage"),
      FileManager.default.fileExists(atPath: r.appending(path: "page.html").path(percentEncoded: false))
    {
      return r
    }
    return URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../web/dist").standardized
  }

  /// ~/Library/Caches/<bundle id, or CodeBoard>/note-snapshots
  public static var defaultCache: URL {
    URL.cachesDirectory.appending(components: Bundle.main.bundleIdentifier ?? "CodeBoard", "note-snapshots")
  }

  private let pageFolder: URL
  /// The Note page's build: what draws a Note, its stylesheets and fonts
  public let build: String
  private let store: SnapshotStore
  private var page: NotePage?
  private var busy = false
  private var queue = RenderQueue()
  private var turns: [Int: CheckedContinuation<Void, any Error>] = [:]
  private var nextID = 0
  private var idle: Task<Void, Never>?
  /// Pictures are written to the disk cache after they are handed over, one at a time: compressing one takes longer
  /// than drawing it, and many at once would each hold a copy of its pixels
  private let writes = DispatchQueue(label: "NoteRenderer.writes", qos: .utility)

  /// Waits until every picture and size handed over so far is in the disk cache
  package func written() async {
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in writes.async { c.resume() } }
  }

  /// Whether the web view is open now (it costs a web process, about 100 MB, and 3–5 MB for each Note mounted there)
  public var webViewOpen: Bool { page != nil }

  public init(page: URL = bundledPage, cache: URL = defaultCache) {
    pageFolder = page
    build = (try? String(contentsOf: page.appending(path: "build-id"), encoding: .utf8)) ?? ""
    store = SnapshotStore(folder: cache, limit: 1 << 30)
  }

  /// `note` on a card `width` wide (and `height` tall; nil: as tall as its content), its images resolving against
  /// `folder` (the board package or `.codeboard/shared`), as `scale` device pixels per point, in the board theme `look`
  /// (its id: warm-ink, ink-wash) and its `dark` variant or not, its [[refs]] drawn as `refs` resolve them. Among the requests waiting for the web
  /// view a higher `priority` goes first; a request cancelled before its turn draws nothing.
  public func snapshot(
    of note: NoteBody, width: Double, height: Double?, folder: URL, scale: Double, look: String, dark: Bool,
    refs: [NoteRef] = [], hideHead: Bool = false, priority: Int
  ) async throws -> NoteSnapshot {
    let json = try PageNote(
      note, width: width, height: height, look: look, dark: dark, refs: refs, hideHead: hideHead
    ).json()
    let (key, mount, cached) = await Self.lookUp(
      store: store, build: build, note: json, markdown: note.markdown, folder: folder, scale: scale)
    if let cached { return cached }
    return try await draw(as: key, priority: priority) { p in
      var size = p.mountedSize(mount.hex)
      if size == nil {
        size = try await p.mount([(mount.hex, json, Self.images(folder))], look: look, dark: dark)[mount.hex]?.size
      }
      guard let size else { throw NoteRenderError.page("not mounted") }
      return try await p.snapshot(mount.hex, size: size, scale: scale)
    }
  }

  /// An image file (an SVG: ImageIO does not read it, and NSImage draws it without its <style> and CSS variables) drawn
  /// by WebKit as the board's image card shows it, `width` pixels wide and as tall as its proportions make it, on a
  /// `dark` board or not (its prefers-color-scheme rules follow). Drawn as `snapshot` draws a Note: from the disk
  /// cache, else in its turn in the one web view
  public func picture(of file: URL, width: Int, dark: Bool, priority: Int) async throws -> NoteSnapshot {
    let (key, stamp, cached) = await Self.lookUp(store: store, build: build, file: file, width: width, dark: dark)
    if let cached { return cached }
    return try await draw(as: key, priority: priority) { p in
      try await p.picture(of: file, stamp: stamp, width: width, dark: dark)
    }
  }

  /// The picture `picture` would give, if the disk cache has it; never opens the web view
  public func cachedPicture(of file: URL, width: Int, dark: Bool) async -> NoteSnapshot? {
    await Self.lookUp(store: store, build: build, file: file, width: width, dark: dark).2
  }

  /// The picture `snapshot` would give, if the disk cache has it; never opens the web view
  public func cached(
    of note: NoteBody, width: Double, height: Double?, folder: URL, scale: Double, look: String, dark: Bool,
    refs: [NoteRef] = [], hideHead: Bool = false
  ) async -> NoteSnapshot? {
    guard
      let json = try? PageNote(
        note, width: width, height: height, look: look, dark: dark, refs: refs, hideHead: hideHead
      ).json()
    else {
      return nil
    }
    return await Self.lookUp(
      store: store, build: build, note: json, markdown: note.markdown, folder: folder, scale: scale
    ).2
  }

  /// What `sizes` gives, with each Note's blocks as laid out. Those not kept with the snapshots are measured in the web
  /// view together, in one turn, and stay mounted there for their pictures
  public func metrics(of notes: [NoteSizeRequest], priority: Int) async throws -> [NoteMetrics?] {
    var out = [NoteMetrics?](repeating: nil, count: notes.count)
    var missing: [(i: Int, key: SnapshotKey, json: String, images: URL, look: Look)] = []
    for (i, n) in notes.enumerated() {
      guard
        let json = try? PageNote(
          n.note, width: n.width, height: nil, look: n.look, dark: n.dark, refs: n.refs, hideHead: n.hideHead
        ).json()
      else { continue }
      let (key, cached) = await Self.lookUpSize(
        store: store, build: build, note: json, markdown: n.note.markdown, folder: n.folder)
      if let cached {
        out[i] = cached
      } else {
        missing.append((i, key, json, Self.images(n.folder), Look(id: n.look, dark: n.dark)))
      }
    }
    guard !missing.isEmpty else { return out }
    try await takeTurn(priority: priority)
    var shown: [String: NotePage.Measured] = [:]
    do {
      let p = try page ?? NotePage(page: pageFolder)
      page = p
      // one look at a time: the page draws in one
      for look in Set(missing.map(\.look)) {
        let batch = missing.filter { $0.look == look }.map { ($0.key.hex, $0.json, $0.images) }
        shown.merge(try await p.mount(batch, look: look.id, dark: look.dark)) { $1 }
      }
    } catch {
      page = nil
      endTurn()
      throw error
    }
    endTurn()
    var keep: [(SnapshotKey, NoteMetrics)] = []
    for m in missing {
      guard let s = shown[m.key.hex] else { continue }
      let metrics = NoteMetrics(size: s.size, blocks: s.blocks, refs: s.refs)
      out[m.i] = metrics
      // measured without an image that did not come in: too small, so not kept
      if s.complete { keep.append((m.key, metrics)) }
    }
    keepSizes(keep)
    return out
  }

  /// What plain text pasted on the board makes, worked out by the Markdown package and core's paste rules in the page
  /// (board actions/create.ts pasteText); before the pictures waiting, as a person waits for it
  public func paste(_ text: String) async throws -> PastedText {
    try await takeTurn(priority: Int.max)
    defer { endTurn() }
    do {
      let p = try page ?? NotePage(page: pageFolder)
      page = p
      return PastedText(try await p.paste(text))
    } catch {
      page = nil
      throw error
    }
  }

  /// A picture added from a file as main adds it (board actions/create.ts addImage): an SVG cleaned, and the width of its
  /// card from its pixels and a PNG's resolution, else `scale` (a pasted screenshot's: the window's); nil for an SVG
  /// that cannot be read
  public func image(_ dataURL: String, scale: Double = 1) async throws -> (dataURL: String, width: Double)? {
    try await takeTurn(priority: Int.max)
    defer { endTurn() }
    do {
      let p = try page ?? NotePage(page: pageFolder)
      page = p
      return try await p.added(dataURL, scale: scale)
    } catch {
      page = nil
      throw error
    }
  }

  /// The language Free code's text looks like, as the board guesses it (core freeLang); nil when it cannot tell
  public func freeLanguage(_ text: String) async throws -> String? {
    try await takeTurn(priority: Int.max)
    defer { endTurn() }
    do {
      let p = try page ?? NotePage(page: pageFolder)
      page = p
      return try await p.freeLanguage(text)
    } catch {
      page = nil
      throw error
    }
  }

  /// Each Note's size at 100 % and where its first glyph is from its top left (nil when it has none), measured now: what
  /// a Text keeps in place when it becomes a Box (the board measures it the same way, notes.ts setTextLook)
  public func firstGlyphs(of notes: [NoteSizeRequest]) async throws -> [(size: CGSize, first: CGPoint?)?] {
    try await takeTurn(priority: 0)
    defer { endTurn() }
    var out = [(size: CGSize, first: CGPoint?)?](repeating: nil, count: notes.count)
    do {
      let p = try page ?? NotePage(page: pageFolder)
      page = p
      for (i, n) in notes.enumerated() {
        guard
          let json = try? PageNote(
            n.note, width: n.width, height: nil, look: n.look, dark: n.dark, refs: n.refs, hideHead: n.hideHead
          ).json()
        else { continue }
        let (key, _) = await Self.lookUpSize(
          store: store, build: build, note: json, markdown: n.note.markdown, folder: n.folder)
        let sizes = try await p.mount([(key.hex, json, Self.images(n.folder))], look: n.look, dark: n.dark)
        let firsts = try await p.firstGlyphs([key.hex])
        if let s = sizes[key.hex] { out[i] = (s.size, firsts[key.hex]) }
      }
    } catch {
      page = nil
      throw error
    }
    return out
  }

  private struct Look: Hashable {
    var id: String
    var dark: Bool
  }

  nonisolated static func images(_ folder: URL) -> URL {
    folder.appending(path: "images", directoryHint: .notDirectory)
  }

  /// The key at scale 0 stands for what a Note draws at any scale: its measured size is kept under it, and it is the
  /// Note's id in the page
  @concurrent
  private static func lookUpSize(
    store: SnapshotStore, build: String, note: String, markdown: String, folder: URL
  ) async -> (SnapshotKey, NoteMetrics?) {
    let key = SnapshotKey(
      build: build, system: ProcessInfo.processInfo.operatingSystemVersionString, note: note, scale: 0,
      images: SnapshotKey.imageStamps(in: markdown, folder: folder))
    return (key, store.readSize(key))
  }

  /// Written after the measuring is done, off the path to the screen
  private func keepSizes(_ sizes: [(SnapshotKey, NoteMetrics)]) {
    guard !sizes.isEmpty else { return }
    let store = self.store
    writes.async {
      for (key, size) in sizes { try? store.writeSize(size, as: key) }
    }
  }

  @concurrent
  private static func lookUp(
    store: SnapshotStore, build: String, note: String, markdown: String, folder: URL, scale: Double
  ) async -> (SnapshotKey, mount: SnapshotKey, NoteSnapshot?) {
    let images = SnapshotKey.imageStamps(in: markdown, folder: folder)
    let system = ProcessInfo.processInfo.operatingSystemVersionString
    let key = SnapshotKey(build: build, system: system, note: note, scale: scale, images: images)
    let mount = SnapshotKey(build: build, system: system, note: note, scale: 0, images: images)
    return (key, mount, store.read(key))
  }

  @concurrent
  private static func lookUp(
    store: SnapshotStore, build: String, file: URL, width: Int, dark: Bool
  ) async -> (SnapshotKey, String, NoteSnapshot?) {
    // the file by its name (the board names images by their content), size and time; the width as the scale
    let stamp = SnapshotKey.stamp(file)
    let key = SnapshotKey(
      build: build, system: ProcessInfo.processInfo.operatingSystemVersionString, note: dark ? "image dark" : "image",
      scale: Double(width), images: [stamp])
    return (key, stamp, store.read(key))
  }

  /// Draws in the web view in its turn, and keeps the picture when everything in it came in
  private func draw(
    as key: SnapshotKey, priority: Int, _ make: (NotePage) async throws -> (NoteSnapshot, complete: Bool)
  ) async throws -> NoteSnapshot {
    try await takeTurn(priority: priority)
    let drawn: (snapshot: NoteSnapshot, complete: Bool)
    do {
      let p = try page ?? NotePage(page: pageFolder)
      page = p
      drawn = try await make(p)
    } catch {
      // a page that failed once (a script error, its web process gone) is not trusted with the next picture
      page = nil
      endTurn()
      throw error
    }
    endTurn()
    // a picture with an image that did not come in is not kept: it would stand for the image from now on. Written off
    // the path to the screen
    if drawn.complete {
      let store = self.store
      let snap = drawn.snapshot
      writes.async {
        try? store.write(snap, as: key)
      }
    }
    return drawn.snapshot
  }

  // MARK: one request at a time in the web view

  private func takeTurn(priority: Int) async throws {
    try Task.checkCancellation()
    idle?.cancel()
    idle = nil
    if !busy {
      busy = true
      return
    }
    nextID += 1
    let id = nextID
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, any Error>) in
        if Task.isCancelled { return c.resume(throwing: CancellationError()) }
        turns[id] = c
        queue.push(id, priority: priority)
      }
    } onCancel: {
      Task { @MainActor [weak self] in self?.cancel(id) }
    }
  }

  private func cancel(_ id: Int) {
    guard queue.remove(id), let c = turns.removeValue(forKey: id) else { return }
    c.resume(throwing: CancellationError())
  }

  private func endTurn() {
    if let next = queue.pop(), let c = turns.removeValue(forKey: next) {
      return c.resume()
    }
    busy = false
    idle = Task { [weak self] in
      guard (try? await Task.sleep(for: .seconds(30))) != nil else { return }
      self?.page = nil
    }
  }
}

/// What a paste of plain text makes (page.ts pasted)
public enum PastedText: Equatable, Sendable {
  /// A Note of this Markdown
  case note(String)
  case web(String)
  case links([String])
  /// An SVG, cleaned, as a data: URL, and its own width in pixels (0 when it could not be drawn)
  case svg(dataURL: String, natural: Double)
  /// Free code in the language guessed
  case code(String, language: String)
  /// Nothing; `why`, to say, when the text could not be used
  case none(why: String?)

  init(_ d: [String: Any]) {
    switch d["kind"] as? String {
    case "note": self = .note(d["text"] as? String ?? "")
    case "web": self = .web(d["url"] as? String ?? "")
    case "links": self = .links(d["urls"] as? [String] ?? [])
    case "svg": self = .svg(dataURL: d["dataUrl"] as? String ?? "", natural: d["natural"] as? Double ?? 0)
    case "code": self = .code(d["text"] as? String ?? "", language: d["lang"] as? String ?? "python")
    default: self = .none(why: d["error"] as? String)
    }
  }
}
