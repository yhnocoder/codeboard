import AppKit
import CodeBoardModel

/// Draws Notes into bitmaps through the Note page: from the disk cache when the Note was drawn before at that scale,
/// otherwise in the one web view, which is made when needed and closed after 30 s without a request. Requests waiting for
/// the web view go by priority and can be cancelled (cancel the calling task). Letting go of the renderer closes the
/// web view.
@MainActor
public final class NoteRenderer {
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
  private let build: String
  private let store: SnapshotStore
  private var page: NotePage?
  private var busy = false
  private var queue = RenderQueue()
  private var turns: [Int: CheckedContinuation<Void, any Error>] = [:]
  private var nextID = 0
  private var idle: Task<Void, Never>?

  /// Whether the web view is open now (it costs a web process, about 120 MB)
  public var webViewOpen: Bool { page != nil }

  public init(page: URL = bundledPage, cache: URL = defaultCache) {
    pageFolder = page
    build = (try? String(contentsOf: page.appending(path: "build-id"), encoding: .utf8)) ?? ""
    store = SnapshotStore(folder: cache, limit: 1 << 30)
  }

  /// `note` on a card `width` wide (and `height` tall; nil: as tall as its content), its images resolving against
  /// `folder` (the board package or `.codeboard/shared`), as `scale` device pixels per point, in the board theme `look`
  /// (its id: warm-ink, ink-wash). Among the requests waiting for the web view a higher `priority` goes first; a request
  /// cancelled before its turn draws nothing.
  public func snapshot(
    of note: Note, width: Double, height: Double?, folder: URL, scale: Double, look: String, priority: Int
  ) async throws -> NoteSnapshot {
    let json = try PageNote(note, width: width, height: height, look: look).json()
    let (key, cached) = await Self.lookUp(
      store: store, build: build, note: json, markdown: note.text, folder: folder, scale: scale)
    if let cached { return cached }
    try await takeTurn(priority: priority)
    let drawn: (snapshot: NoteSnapshot, complete: Bool)
    do {
      drawn = try await draw(json, folder: folder, scale: scale)
    } catch {
      endTurn()
      throw error
    }
    endTurn()
    // a picture with an image that did not come in is not kept: it would stand for the image from now on
    if drawn.complete { try? await Self.keep(drawn.snapshot, as: key, in: store) }
    return drawn.snapshot
  }

  /// The picture `snapshot` would give, if the disk cache has it; never opens the web view
  public func cached(
    of note: Note, width: Double, height: Double?, folder: URL, scale: Double, look: String
  ) async -> NoteSnapshot? {
    guard let json = try? PageNote(note, width: width, height: height, look: look).json() else { return nil }
    return await Self.lookUp(
      store: store, build: build, note: json, markdown: note.text, folder: folder, scale: scale
    ).1
  }

  /// The size at 100 % of `note` on a card `width` wide that is as tall as its content (a Free Text: as wide as its
  /// text too): what `snapshot` with no height gives as its size, without drawing it. Measured in the web view once,
  /// then kept with the snapshots
  public func size(of note: Note, width: Double, folder: URL, look: String, priority: Int) async throws -> CGSize {
    let json = try PageNote(note, width: width, height: nil, look: look).json()
    let (key, cached) = await Self.lookUpSize(
      store: store, build: build, note: json, markdown: note.text, folder: folder)
    if let cached { return cached }
    try await takeTurn(priority: priority)
    let shown: (size: CGSize, complete: Bool)
    do {
      let p = try page ?? NotePage(page: pageFolder)
      page = p
      shown = try await p.show(note: json, folder: folder)
    } catch {
      page = nil
      endTurn()
      throw error
    }
    endTurn()
    // measured without an image that did not come in: too small, so not kept
    if shown.complete { try? await Self.keepSize(shown.size, as: key, in: store) }
    return shown.size
  }

  @concurrent
  private static func lookUpSize(
    store: SnapshotStore, build: String, note: String, markdown: String, folder: URL
  ) async -> (SnapshotKey, CGSize?) {
    // scale 0: the size alone
    let key = SnapshotKey(
      build: build, system: ProcessInfo.processInfo.operatingSystemVersionString, note: note, scale: 0,
      images: SnapshotKey.imageStamps(in: markdown, folder: folder))
    return (key, store.readSize(key))
  }

  @concurrent
  private static func keepSize(_ size: CGSize, as key: SnapshotKey, in store: SnapshotStore) async throws {
    try store.writeSize(size, as: key)
  }

  @concurrent
  private static func lookUp(
    store: SnapshotStore, build: String, note: String, markdown: String, folder: URL, scale: Double
  ) async -> (SnapshotKey, NoteSnapshot?) {
    let key = SnapshotKey(
      build: build, system: ProcessInfo.processInfo.operatingSystemVersionString, note: note, scale: scale,
      images: SnapshotKey.imageStamps(in: markdown, folder: folder))
    return (key, store.read(key))
  }

  @concurrent
  private static func keep(_ snap: NoteSnapshot, as key: SnapshotKey, in store: SnapshotStore) async throws {
    try store.write(snap, as: key)
  }

  private func draw(_ json: String, folder: URL, scale: Double) async throws -> (NoteSnapshot, Bool) {
    let p = try page ?? NotePage(page: pageFolder)
    page = p
    do {
      let shown = try await p.show(note: json, folder: folder)
      return (try await p.snapshot(size: shown.size, scale: scale), shown.complete)
    } catch {
      // a page that failed once (a script error, its web process gone) is not trusted with the next Note
      page = nil
      throw error
    }
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
