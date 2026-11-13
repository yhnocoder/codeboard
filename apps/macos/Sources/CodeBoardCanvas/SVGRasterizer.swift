import AppKit
import CodeBoardNotes

/// Rasterizes SVG image files as the web board's image card shows them (an <img>: the SVG's own <style>, CSS variables
/// and prefers-color-scheme rules, which NSImage and ImageIO do not draw): from the disk cache when the file was drawn at
/// that width before, otherwise in one web view (`SVGPage`), made on the first SVG that needs it and closed after 30 s
/// without a request. A board with no SVG image never starts it. Requests waiting for the web view go by priority and
/// can be cancelled (cancel the calling task). Letting go of the rasterizer closes the web view.
@MainActor
package final class SVGRasterizer {
  /// ~/Library/Caches/<bundle id, or CodeBoard>/svg-pictures
  static var defaultCache: URL {
    URL.cachesDirectory.appending(components: Bundle.main.bundleIdentifier ?? "CodeBoard", "svg-pictures")
  }

  private let assets: URL
  /// how long WebKit may take over each step of a picture before it fails (and the page is closed)
  private let limit: Duration
  private let build: String
  private let store: SnapshotStore
  private var page: SVGPage?
  private var busy = false
  private var queue = RenderQueue()
  private var turns: [Int: CheckedContinuation<Void, any Error>] = [:]
  private var nextID = 0
  private var idle: Task<Void, Never>?
  /// Pictures are written to the disk cache after they are handed over, one at a time, off the path to the screen
  private let writes = DispatchQueue(label: "SVGRasterizer.writes", qos: .utility)
  /// How many times a web view was made (CanvasBench, tests)
  package private(set) var pagesMade = 0

  /// Waits until every picture handed over so far is in the disk cache
  package func written() async {
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in writes.async { c.resume() } }
  }

  /// Whether the web view is open now (it costs a web process)
  package var webViewOpen: Bool { page != nil }

  package init(assets: URL = NativeNotes.assets, cache: URL = defaultCache, limit: Duration = .seconds(10)) {
    self.assets = assets
    self.limit = limit
    build = (try? String(contentsOf: assets.appending(path: "build-id"), encoding: .utf8)) ?? ""
    store = SnapshotStore(folder: cache, limit: 256 << 20)
  }

  /// The file drawn `width` pixels wide and as tall as its proportions make it, on a `dark` board or not (its
  /// prefers-color-scheme rules follow): from the disk cache, else in its turn in the web view
  func picture(of file: URL, width: Int, dark: Bool, priority: Int) async throws -> SVGPicture {
    let (key, stamp, cached) = await Self.lookUp(store: store, build: build, file: file, width: width, dark: dark)
    if let cached { return cached }
    try await takeTurn(priority: priority)
    let drawn: (picture: SVGPicture, complete: Bool)
    do {
      let p = try page ?? makePage()
      page = p
      drawn = try await p.picture(of: file, stamp: stamp, width: width, dark: dark)
    } catch {
      // a page that failed once (a script error, its web process gone, a step that never came back) is not trusted
      // with the next picture
      page?.close()
      page = nil
      endTurn()
      throw error
    }
    endTurn()
    // a picture of a file that did not load is not kept: it would stand for the file from now on
    if drawn.complete {
      let store = self.store
      let pic = drawn.picture
      writes.async { try? store.write(pic, as: key) }
    }
    return drawn.picture
  }

  /// The picture `picture` would give, if the disk cache has it; never opens the web view
  func cachedPicture(of file: URL, width: Int, dark: Bool) async -> SVGPicture? {
    await Self.lookUp(store: store, build: build, file: file, width: width, dark: dark).2
  }

  private func makePage() throws -> SVGPage {
    pagesMade += 1
    return try SVGPage(assets: assets, limit: limit)
  }

  @concurrent
  private static func lookUp(
    store: SnapshotStore, build: String, file: URL, width: Int, dark: Bool
  ) async -> (SnapshotKey, String, SVGPicture?) {
    // the file by its name (the board names images by their content), size and time; the width as the scale
    let stamp = SnapshotKey.stamp(file)
    let key = SnapshotKey(
      build: build, system: ProcessInfo.processInfo.operatingSystemVersionString, what: dark ? "image dark" : "image",
      scale: Double(width), images: [stamp])
    return (key, stamp, store.read(key))
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
