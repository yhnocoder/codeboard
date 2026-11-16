import Foundation

/// What a display that lays Notes out in this process (the native component) measured, kept on disk as the renderer
/// keeps its sizes, so a board opened after a relaunch is not laid out whole before it shows. A size is kept under a
/// hash of everything that changes it: `build` (what lays out: the component's code, fonts and engines), the system's
/// version, the Note as the page would get it (its Markdown, layout, style, width, look, appearance, refs), its images
/// by name, size and time, and `extra` (the caller's: the pictures read from web addresses). Reads run on the caller's
/// thread; writes after the measuring, one at a time, off the path to the screen.
package final class MeasuredSizes: Sendable {
  private let store: SnapshotStore
  private let build: String
  private let writes = DispatchQueue(label: "MeasuredSizes.writes", qos: .utility)

  /// Sizes are a few hundred bytes each: the default bound keeps a few hundred thousand
  package init(folder: URL, build: String, limit: Int = 64 << 20) {
    store = SnapshotStore(folder: folder, limit: limit)
    self.build = build
  }

  /// A size's key, or with `scale` a picture's, `height` tall (nil: as tall as its content); nil when the Note cannot
  /// be described to the page (then it is never kept)
  package func key(_ n: NoteSizeRequest, height: Double? = nil, scale: Double = 0, extra: [String]) -> SizeKey? {
    guard
      let json = try? PageNote(
        n.note, width: n.width, height: height, look: n.look, dark: n.dark, refs: n.refs, hideHead: n.hideHead
      ).json()
    else { return nil }
    return SizeKey(
      key: SnapshotKey(
        build: build, system: ProcessInfo.processInfo.operatingSystemVersionString, note: json, scale: scale,
        images: SnapshotKey.imageStamps(in: n.note.markdown, folder: n.folder) + extra))
  }

  package func read(_ k: SizeKey) -> NoteMetrics? { store.readSize(k.key) }

  /// A picture kept under a key with its scale
  package func readPicture(_ k: SizeKey) -> NoteSnapshot? { store.read(k.key) }

  package func writePicture(_ s: NoteSnapshot, _ k: SizeKey) {
    let store = self.store
    writes.async { try? store.write(s, as: k.key) }
  }

  package func write(_ sizes: [(SizeKey, NoteMetrics)]) {
    guard !sizes.isEmpty else { return }
    let store = self.store
    writes.async { for (k, m) in sizes { try? store.writeSize(m, as: k.key) } }
  }

  /// Waits until every size handed over so far is written
  package func written() async {
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in writes.async { c.resume() } }
  }

  /// A file as "name size mtime", or "name -" when missing: a part of `build` or `extra`
  package static func stamp(_ file: URL) -> String { SnapshotKey.stamp(file) }
}

package struct SizeKey: Sendable {
  fileprivate let key: SnapshotKey
}

/// Small results kept on disk under a hash of what makes them (`build`, the system's version and the caller's parts):
/// the native component's typeset formulas and diagrams, so a board after a relaunch draws them without starting the
/// engines. Reads on the caller's thread; writes one at a time, off the path to the screen.
package final class KeptData: Sendable {
  private let store: SnapshotStore
  private let build: String
  private let writes = DispatchQueue(label: "KeptData.writes", qos: .utility)

  package init(folder: URL, build: String, limit: Int) {
    store = SnapshotStore(folder: folder, limit: limit)
    self.build = build
  }

  private func key(_ parts: [String]) -> SnapshotKey {
    SnapshotKey(
      build: build, system: ProcessInfo.processInfo.operatingSystemVersionString,
      note: parts.joined(separator: "\u{0}"),
      scale: 0, images: [])
  }

  package func read(_ parts: [String]) -> Data? { store.readData(key(parts)) }

  package func write(_ data: Data, _ parts: [String]) {
    let (store, k) = (self.store, key(parts))
    writes.async { try? store.writeData(data, as: k) }
  }

  /// Waits until everything handed over so far is written
  package func written() async {
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in writes.async { c.resume() } }
  }
}
